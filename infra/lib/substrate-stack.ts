import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodelambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'node:path';
import type { GitHubConfig, ReviewerId, SkillsRepoConfig } from './deployment-config';

export interface SubstrateStackProps extends cdk.StackProps {
  readonly github: Pick<GitHubConfig, 'appId' | 'appSecretName' | 'botLogin' | 'knownBotLogins'>;
  /** Per reviewer, the repositories ("owner/name") its token broker may issue tokens for. */
  readonly allowedRepos: Readonly<Record<ReviewerId, readonly string[]>>;
  /** The bot's own repository. When set, a token broker for it is created for the curator. */
  readonly skillsRepo?: Pick<SkillsRepoConfig, 'repo' | 'appSecretName'>;
  /**
   * Repositories that project readiness onto a GitHub label. When non-empty,
   * a ReadyLabelFn is created that mints pull_requests:write itself and
   * never returns a token.
   */
  readonly readyLabels?: Readonly<Record<string, string>>;
}

/**
 * Resources shared by every agent in one account and region: the KMS key,
 * the prompt and skill bucket, the GitHub App secret, one token broker per
 * reviewer, the skills-repo token broker when configured, the ready-label
 * Lambda when a route sets readyLabel, and the run heartbeat table. Each
 * agent stack creates its own execution role and grants it only what that
 * agent uses.
 */
export class SubstrateStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly assetsBucket: s3.Bucket;
  readonly githubAppSecret: secretsmanager.ISecret;
  readonly heartbeatTable: dynamodb.Table;
  readonly tokenBrokers: ReadonlyMap<ReviewerId, lambda.IFunction>;
  /** Issues tokens for the bot's own repository; set only when skillsRepo is configured. */
  readonly skillsRepoTokenBroker?: lambda.IFunction;
  /**
   * Projects this App's review readiness onto a PR label. Set only when
   * at least one route has readyLabel.
   */
  readonly readyLabelFn?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: SubstrateStackProps) {
    super(scope, id, props);

    // One customer-managed key for assets and concerns tables, so access
    // can be audited and revoked in one place.
    this.key = new kms.Key(this, 'SubstrateKey', {
      alias: 'alias/valkey-reviewer-substrate',
      description: 'Encrypts valkey-reviewer prompt and skill assets and the concerns tables.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Prompts and skills, one prefix per agent (for example
    // valkey-review/prompt.md). Versioned so a bad prompt can be rolled
    // back without a redeploy.
    this.assetsBucket = new s3.Bucket(this, 'AgentAssets', {
      bucketName: `valkey-reviewer-assets-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The secret is created by the operator (see infra/README.md) and only
    // referenced here, so a stack update can never replace the App key.
    this.githubAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitHubAppSecret',
      props.github.appSecretName,
    );

    // Reviewer runtimes build and run code from the pull request under
    // review, so they never see the App private key. Each reviewer gets its
    // own broker (webhook/src/token-broker.ts) that issues short-lived
    // tokens only for that reviewer's routed repositories, and each runtime
    // role may invoke only its own broker.
    const webhookRoot = path.join(__dirname, '..', '..', 'webhook');
    const brokers = new Map<ReviewerId, lambda.IFunction>();
    for (const [reviewerId, repos] of Object.entries(props.allowedRepos) as [ReviewerId, readonly string[]][]) {
      const name = brokerConstructName(reviewerId);
      const broker = new nodelambda.NodejsFunction(this, `TokenBroker${name}Fn`, {
        entry: path.join(webhookRoot, 'src', 'token-broker.ts'),
        depsLockFilePath: path.join(webhookRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        description: `Issues repo-scoped GitHub installation tokens to the ${reviewerId} runtime.`,
        environment: {
          GITHUB_SECRET_ARN: this.githubAppSecret.secretArn,
          GITHUB_APP_ID: props.github.appId,
          ALLOWED_REPOS_JSON: JSON.stringify(repos),
        },
        logGroup: new logs.LogGroup(this, `TokenBroker${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
        bundling: { externalModules: ['@aws-sdk/*'], target: 'node24', minify: false, sourceMap: true },
      });
      this.githubAppSecret.grantRead(broker);
      brokers.set(reviewerId, broker);
      new cdk.CfnOutput(this, `TokenBroker${name}FunctionName`, { value: broker.functionName });
    }
    this.tokenBrokers = brokers;

    // The curator's maintenance mode proposes edits to the reviewers' repo
    // skill files as pull requests against the bot's own repository. This
    // broker (webhook/src/skills-repo-broker.ts) issues it tokens limited
    // to that one repository, with contents and pull request write. The
    // repository comes from its environment, never from the payload. Only
    // the curator role may invoke it (curator-agent-stack.ts); no reviewer
    // runtime or reviewer broker can reach it.
    if (props.skillsRepo) {
      const secretName = props.skillsRepo.appSecretName;
      const broker = new nodelambda.NodejsFunction(this, 'SkillsRepoTokenBrokerFn', {
        entry: path.join(webhookRoot, 'src', 'skills-repo-broker.ts'),
        depsLockFilePath: path.join(webhookRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        description: 'Issues contents/pull-request tokens for the bot repository to the curator.',
        environment: {
          SKILLS_REPO: props.skillsRepo.repo,
          // Passed as the SecretId.
          SKILLS_REPO_APP_SECRET_NAME: secretName,
        },
        logGroup: new logs.LogGroup(this, 'SkillsRepoTokenBrokerLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        bundling: { externalModules: ['@aws-sdk/*'], target: 'node24', minify: false, sourceMap: true },
      });
      // The broker only calls GetSecretValue, on this one secret (the main
      // App's when skillsRepo.appSecretName is not set). The six-character
      // wildcard matches the suffix Secrets Manager adds to the name.
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ReadSkillsRepoAppSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [this.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${secretName}-??????`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })],
      }));
      this.skillsRepoTokenBroker = broker;
      new cdk.CfnOutput(this, 'SkillsRepoTokenBrokerFunctionName', { value: broker.functionName });
    }

    // This function mints pull_requests:write itself and never returns a
    // token. It is created only when a route sets readyLabel. The reviewer
    // token already has that permission for the repository under review;
    // this function is the automatic projection, not a second capability.
    const readyLabels = props.readyLabels ?? {};
    const labeledRepos = Object.keys(readyLabels);
    if (labeledRepos.length > 0) {
      const dlq = new sqs.Queue(this, 'ReadyLabelDlq', { retentionPeriod: cdk.Duration.days(14) });
      const fn = new nodelambda.NodejsFunction(this, 'ReadyLabelFn', {
        entry: path.join(webhookRoot, 'src', 'ready-label-broker.ts'),
        depsLockFilePath: path.join(webhookRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        // One isolate at a time: async Event invokes cannot overlap a POST
        // with a DELETE on the same PR. A throttled Event is retried.
        reservedConcurrentExecutions: 1,
        onFailure: new destinations.SqsDestination(dlq),
        description: 'Projects this App\'s review readiness onto a configured pull request label.',
        environment: {
          GITHUB_SECRET_ARN: this.githubAppSecret.secretArn,
          GITHUB_APP_ID: props.github.appId,
          BOT_LOGIN: props.github.botLogin,
          ALLOWED_REPOS_JSON: JSON.stringify(labeledRepos),
          READY_LABEL_BY_REPO_JSON: JSON.stringify(readyLabels),
          ...(props.github.knownBotLogins?.length ? { KNOWN_BOT_LOGINS: props.github.knownBotLogins.join(',') } : {}),
        },
        logGroup: new logs.LogGroup(this, 'ReadyLabelFnLogs', { retention: logs.RetentionDays.ONE_MONTH }),
        bundling: { externalModules: ['@aws-sdk/*'], target: 'node24', minify: false, sourceMap: true },
      });
      this.githubAppSecret.grantRead(fn);
      this.readyLabelFn = fn;
      new cdk.CfnOutput(this, 'ReadyLabelFunctionName', { value: fn.functionName });
      new cdk.CfnOutput(this, 'ReadyLabelDeadLetterQueueName', {
        value: dlq.queueName,
        description: 'Dead-letter queue for ready-label invokes that exhaust Lambda retries. Alarm on AWS/SQS ApproximateNumberOfMessagesVisible > 0 with dimension QueueName.',
      });
    }

    // Liveness record for long reviews. The runtime updates last_activity
    // on every agent event; on SQS redelivery the worker reads it to tell a
    // slow run (normal for large reviews) from a dead one, which it retries
    // on the fallback model. Key: run_key = repo#pr#head_sha.
    this.heartbeatTable = new dynamodb.Table(this, 'RunHeartbeatTable', {
      tableName: 'valkey_reviewer_run_heartbeat',
      partitionKey: { name: 'run_key', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'AssetsBucketName', { value: this.assetsBucket.bucketName });
    new cdk.CfnOutput(this, 'SubstrateKeyArn', { value: this.key.keyArn });
  }
}

/** "valkey-glide-review" -> "ValkeyGlideReview", for construct ids. */
function brokerConstructName(reviewerId: string): string {
  return reviewerId.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
