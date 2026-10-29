import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodelambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { bedrockModelArns } from './bedrock-arns';
import type { CuratorOnlyRouteConfig, GitHubConfig, ModelsConfig, RouteConfig } from './deployment-config';

/** Workers run up to the Lambda maximum; SQS must hide a message for longer than that. */
const WORKER_TIMEOUT = cdk.Duration.minutes(15);
const QUEUE_VISIBILITY = cdk.Duration.minutes(16);

/**
 * Review workers use redelivery as a watchdog. On each receive after the
 * first they read the run heartbeat and either wait one more visibility
 * timeout or retry on the fallback model, until the run budget
 * (RUN_BUDGET_MINUTES, default 90, in webhook/src/config.ts) ends the message. A healthy long review is
 * received up to ceil(90 / 16) + 1 = 7 times, so the dead-letter threshold
 * sits one above that.
 */
const REVIEW_MAX_RECEIVES = 8;
/**
 * The curator has no watchdog, so every receive is a new run. Three
 * attempts ride out a passing failure such as throttling without spending
 * more model calls on an event that keeps failing.
 */
const CURATOR_MAX_RECEIVES = 3;

/** Concurrent workers per review route and for the curator. Bounds model spend under a burst. */
const REVIEW_MAX_CONCURRENCY = 5;
const CURATOR_MAX_CONCURRENCY = 2;

/**
 * Receiver and API limits. They cap cost if the endpoint is flooded.
 * GitHub does not retry a throttled delivery on its own; it can be
 * redelivered from the App's advanced settings.
 */
const RECEIVER_RESERVED_CONCURRENCY = 10;
const API_RATE_LIMIT = 20;
const API_BURST_LIMIT = 40;

export interface WebhookRoute extends RouteConfig {
  /** AgentCore runtime that reviews pull requests on this route. */
  readonly runtimeArn: string;
}

export interface WebhookStackProps extends cdk.StackProps {
  readonly githubAppSecret: secretsmanager.ISecret;
  readonly github: Pick<GitHubConfig, 'botLogin' | 'installationId' | 'knownBotLogins'>;
  /** Review workers read it on redelivery to tell slow runs from dead ones. */
  readonly heartbeatTable: dynamodb.ITable;
  /** Repositories the reviewers post on. The curator learns from them too. */
  readonly routes: readonly WebhookRoute[];
  /** More repositories the curator learns from, where no reviewer ever runs. */
  readonly curatorOnlyRoutes: readonly CuratorOnlyRouteConfig[];
  readonly curatorRuntimeArn: string;
  readonly models: Pick<ModelsConfig, 'safetyGate' | 'profileRegions'>;
  /** Automatic reviews per route per UTC day. Maintainer summons are not counted. */
  readonly dailyReviewBudget: number;
  /** Automatic reviews per pull request, counting the first. */
  readonly maxAutomaticReviewsPerPr: number;
  /** SQS delay of a review that new commits start. */
  readonly pushReviewDelaySeconds: number;
  /** Projects readiness onto a PR label. Absent when no route sets readyLabel. */
  readonly readyLabelFunction?: lambda.IFunction;
}

/** One entry of REVIEW_ROUTE_MAP_JSON, keyed by repository full name. */
export interface ReviewRouteEntry {
  readonly routeId: string;
  readonly queueUrl: string;
  readonly reviewerId: string;
  readonly authorAllowlist?: readonly string[];
  readonly mentionOnly?: true;
  readonly skipDrafts?: true;
  readonly threadReplyReview?: true;
  readonly readyLabel?: string;
}

/**
 * The two route maps handed to the receiver. Only repositories in the
 * review map can start a review. The curator map is the review map plus
 * the curator-only routes, so a curator-only repository can teach the
 * curator but never trigger a review.
 */
export function routeMaps(
  routes: readonly RouteConfig[],
  curatorOnlyRoutes: readonly CuratorOnlyRouteConfig[],
  queueUrlOf: (routeId: string) => string,
): { review: Record<string, ReviewRouteEntry>; curator: Record<string, { reviewerId: string }> } {
  const review: Record<string, ReviewRouteEntry> = {};
  const curator: Record<string, { reviewerId: string }> = {};
  for (const route of routes) {
    review[route.repo] = {
      routeId: route.id,
      queueUrl: queueUrlOf(route.id),
      reviewerId: route.reviewer,
      ...(route.authorAllowlist.length > 0 ? { authorAllowlist: route.authorAllowlist } : {}),
      ...(route.mentionOnly ? { mentionOnly: true } : {}),
      ...(route.skipDrafts ? { skipDrafts: true } : {}),
      ...(route.threadReplyReview ? { threadReplyReview: true } : {}),
      ...(route.readyLabel ? { readyLabel: route.readyLabel } : {}),
    };
    curator[route.repo] = { reviewerId: route.reviewer };
  }
  for (const route of curatorOnlyRoutes) curator[route.repo] = { reviewerId: route.reviewer };
  return { review, curator };
}

/** Construct-id form of a route id. Kept stable so updates do not replace queues. */
export function routeConstructId(routeId: string): string {
  return routeId.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * GitHub App webhook ingress:
 *
 *   GitHub -> HTTP API -> receiver Lambda -> per-route SQS queue -> worker
 *   Lambda -> InvokeAgentRuntime on the route's reviewer runtime
 *
 * The receiver verifies the signature, deduplicates deliveries in the
 * idempotency table, applies the review budget and routes by repository.
 * Feedback events go to the curator queue instead. Each route has its own
 * queue and worker so a backlog or failure on one does not block another.
 */
export class WebhookStack extends cdk.Stack {
  /** Dead-letter queue per review route id, plus "curator". */
  readonly deadLetterQueues = new Map<string, sqs.Queue>();
  /** Feedback from the receiver and skill maintenance requests from the decay job. */
  readonly curatorQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: WebhookStackProps) {
    super(scope, id, props);

    const webhookRoot = path.join(__dirname, '..', '..', 'webhook');
    const webhookSrc = path.join(webhookRoot, 'src');
    const depsLock = path.join(webhookRoot, 'package-lock.json');
    const bundling: nodelambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      target: 'node24',
      minify: false,
      sourceMap: true,
    };
    const workerFunction = (fnId: string, environment: Record<string, string>) =>
      new nodelambda.NodejsFunction(this, fnId, {
        entry: path.join(webhookSrc, 'invoker.ts'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: WORKER_TIMEOUT,
        memorySize: 512,
        logGroup: new logs.LogGroup(this, `${fnId}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
        environment,
        projectRoot: webhookRoot,
        depsLockFilePath: depsLock,
        bundling,
      });
    const queueWithDlq = (queueId: string, dlqId: string, maxReceiveCount: number) => {
      const dlq = new sqs.Queue(this, dlqId, { retentionPeriod: cdk.Duration.days(14) });
      const queue = new sqs.Queue(this, queueId, {
        retentionPeriod: cdk.Duration.days(14),
        visibilityTimeout: QUEUE_VISIBILITY,
        deadLetterQueue: { queue: dlq, maxReceiveCount },
      });
      return { queue, dlq };
    };

    const idempotency = new dynamodb.Table(this, 'IdempotencyTable', {
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const queueUrls = new Map<string, string>();
    const queueArns: string[] = [];
    for (const route of props.routes) {
      const safeId = routeConstructId(route.id);
      const { queue, dlq } = queueWithDlq(`DeliveryQueue${safeId}`, `DeliveryDlq${safeId}`, REVIEW_MAX_RECEIVES);
      this.deadLetterQueues.set(route.id, dlq);
      queueUrls.set(route.id, queue.queueUrl);
      queueArns.push(queue.queueArn);

      const worker = workerFunction(`WorkerFn${safeId}`, {
        RUNTIME_ARN: route.runtimeArn,
        HEARTBEAT_TABLE: props.heartbeatTable.tableName,
        IDEMPOTENCY_TABLE: idempotency.tableName,
      });
      // Heartbeat reads on redelivery and the pull request's running
      // reviews (GetItem, Scan), and the run's start record, which the
      // worker writes with a conditional UpdateItem just before the invoke.
      props.heartbeatTable.grantReadData(worker);
      props.heartbeatTable.grant(worker, 'dynamodb:UpdateItem');
      // An automatic review's pending marker (pending#<repo>#<pr>, written
      // by the receiver): the worker reads it, extends it while the review
      // waits and deletes it when the run starts, each conditioned on the
      // marker id. It touches no other item, so the grant is limited to
      // that key prefix: no delivery keys, budget or round counters. Grant
      // all three together: a worker that can read the marker but not
      // delete it dead-letters every automatic review.
      worker.addToRolePolicy(new iam.PolicyStatement({
        sid: 'PendingReviewMarkers',
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [idempotency.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['pending#*'] } },
      }));
      worker.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        maxConcurrency: REVIEW_MAX_CONCURRENCY,
      }));
      worker.addToRolePolicy(new iam.PolicyStatement({
        sid: 'InvokeAgentRuntime',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [route.runtimeArn, `${route.runtimeArn}/*`],
      }));

      new cdk.CfnOutput(this, `QueueUrl${safeId}`, { value: queue.queueUrl });
      new cdk.CfnOutput(this, `DeadLetterQueueName${safeId}`, {
        value: dlq.queueName,
        description: `Dead-letter queue for route ${route.id}. Alarm on AWS/SQS ApproximateNumberOfMessagesVisible > 0 with dimension QueueName.`,
      });
    }

    const { queue: curatorQueue, dlq: curatorDlq } = queueWithDlq('CuratorQueue', 'CuratorDlq', CURATOR_MAX_RECEIVES);
    this.curatorQueue = curatorQueue;
    this.deadLetterQueues.set('curator', curatorDlq);
    queueArns.push(curatorQueue.queueArn);
    const curatorWorker = workerFunction('CuratorWorkerFn', { RUNTIME_ARN: props.curatorRuntimeArn });
    curatorWorker.addEventSource(new lambdaEventSources.SqsEventSource(curatorQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: CURATOR_MAX_CONCURRENCY,
    }));
    curatorWorker.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeCuratorRuntime',
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.curatorRuntimeArn, `${props.curatorRuntimeArn}/*`],
    }));
    // scripts/skill-check.mjs --webhook-stack reads this output.
    new cdk.CfnOutput(this, 'CuratorQueueUrl', { value: curatorQueue.queueUrl });
    new cdk.CfnOutput(this, 'CuratorDeadLetterQueueName', {
      value: curatorDlq.queueName,
      description: 'Dead-letter queue for curator messages. Alarm on AWS/SQS ApproximateNumberOfMessagesVisible > 0 with dimension QueueName.',
    });

    const maps = routeMaps(props.routes, props.curatorOnlyRoutes, (routeId) => queueUrls.get(routeId)!);
    const github = props.github;
    const receiver = new nodelambda.NodejsFunction(this, 'ReceiverFn', {
      entry: path.join(webhookSrc, 'receiver.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: RECEIVER_RESERVED_CONCURRENCY,
      logGroup: new logs.LogGroup(this, 'ReceiverFnLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        REVIEW_ROUTE_MAP_JSON: this.toJsonString(maps.review),
        CURATOR_ROUTE_MAP_JSON: JSON.stringify(maps.curator),
        IDEMPOTENCY_TABLE: idempotency.tableName,
        GITHUB_SECRET_ARN: props.githubAppSecret.secretArn,
        CURATOR_QUEUE_URL: curatorQueue.queueUrl,
        BOT_LOGIN: github.botLogin,
        HAIKU_MODEL_ID: props.models.safetyGate,
        DAILY_REVIEW_BUDGET: String(props.dailyReviewBudget),
        MAX_AUTOMATIC_REVIEWS_PER_PR: String(props.maxAutomaticReviewsPerPr),
        PUSH_REVIEW_DELAY_SECONDS: String(props.pushReviewDelaySeconds),
        ...(github.installationId ? { INSTALLATION_ID: github.installationId } : {}),
        // The receiver treats any set value as the whole list, so an empty
        // list must leave the variable unset to keep the built-in logins.
        ...(github.knownBotLogins?.length ? { KNOWN_BOT_LOGINS: github.knownBotLogins.join(',') } : {}),
        ...(props.readyLabelFunction ? { READY_LABEL_FUNCTION: props.readyLabelFunction.functionName } : {}),
      },
      projectRoot: webhookRoot,
      depsLockFilePath: depsLock,
      bundling,
    });

    // The idempotency table also holds the per-route daily review
    // counters, the per-pull-request round counters and pending markers.
    idempotency.grantReadWriteData(receiver);
    props.githubAppSecret.grantRead(receiver);
    props.readyLabelFunction?.grantInvoke(receiver);
    // Safety gate on maintainer instructions in @mentions (Converse API).
    receiver.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeSafetyModel',
      actions: ['bedrock:InvokeModel'],
      resources: bedrockModelArns(this, props.models.safetyGate, props.models.profileRegions),
    }));
    receiver.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SendToRouteQueues',
      actions: ['sqs:SendMessage', 'sqs:GetQueueUrl'],
      resources: queueArns,
    }));

    const api = new apigwv2.HttpApi(this, 'WebhookApi', {
      description: 'GitHub App webhook ingress for valkey-reviewer.',
    });
    const defaultStage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: API_RATE_LIMIT,
      throttlingBurstLimit: API_BURST_LIMIT,
    };
    api.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2int.HttpLambdaIntegration('ReceiverIntegration', receiver),
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.apiEndpoint}/webhook`,
      description: 'Webhook URL for the GitHub App settings.',
    });
    new cdk.CfnOutput(this, 'IdempotencyTableName', { value: idempotency.tableName });
  }
}
