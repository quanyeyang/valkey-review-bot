import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { modelAccessStatements } from './bedrock-arns';
import type { ModelsConfig, ReviewerAgentConfig, ReviewerId } from './deployment-config';
import { createRuntimeRole, registryResources } from './grants';

/**
 * A review reports HealthyBusy on /ping for as long as it runs, so the
 * 15-minute idle timeout never stops a working session. maxLifetime bounds
 * a run that hangs instead: the watchdog gives up on a review after its
 * run budget (RUN_BUDGET_MINUTES, default 90), so a session still busy
 * after two hours is stuck.
 */
const SESSION_IDLE_TIMEOUT_SECONDS = 15 * 60;
const SESSION_MAX_LIFETIME_SECONDS = 2 * 60 * 60;

export interface AgentStackProps extends cdk.StackProps {
  readonly agentId: ReviewerId;
  readonly description: string;
  /** Docker build context; the repository root. */
  readonly agentSourcePath: string;
  /** Dockerfile path relative to agentSourcePath. */
  readonly dockerfile: string;
  /** Checkout location inside the container; must match the Dockerfile. */
  readonly workspaceRoot: string;
  readonly skillPath: string;
  readonly promptPath: string;
  readonly assetsBucket: s3.IBucket;
  readonly substrateKey: kms.IKey;
  readonly heartbeatTable: dynamodb.ITable;
  readonly tokenBroker: lambda.IFunction;
  /** Projects readiness onto a PR label. Absent when no route sets readyLabel. */
  readonly readyLabelFunction?: lambda.IFunction;
  readonly githubAppId: string;
  /** The reviewer's agent-skills registry (ID or ARN). */
  readonly skillsRegistry: string;
  /** "owner/name" whose release branches the reviewer fetches; empty uses the PR's repository. */
  readonly upstreamRepo: string;
  readonly agent: ReviewerAgentConfig;
  readonly models: Pick<ModelsConfig,
    'reviewer' | 'summarizer' | 'profileRegions' | 'mantleRegion' | 'mantleGrantRegions' | 'extraGrants'>;
}

/**
 * One reviewer: its AgentCore runtime, execution role and concerns table.
 * The container is self-contained: it checks out the pull request, runs
 * builds and searches, and posts the review.
 */
export class ValkeyReviewAgentStack extends cdk.Stack {
  readonly runtime: agentcore.CfnRuntime;
  readonly role: iam.Role;
  readonly concernsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    new s3deploy.BucketDeployment(this, 'AgentAssets', {
      sources: [
        s3deploy.Source.asset(path.dirname(props.skillPath), {
          exclude: ['*', `!${path.basename(props.skillPath)}`, `!${path.basename(props.promptPath)}`],
        }),
      ],
      destinationBucket: props.assetsBucket,
      destinationKeyPrefix: `${props.agentId}/`,
      prune: false,
    });

    const skillKey = `${props.agentId}/${path.basename(props.skillPath)}`;
    const promptKey = `${props.agentId}/${path.basename(props.promptPath)}`;

    const image = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
      directory: props.agentSourcePath,
      file: props.dockerfile,
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    // The curator's notebook of maintainer feedback for this reviewer. The
    // reviewer never reads it: a single comment is not yet a pattern.
    // Patterns reach the reviewer only after the curator sees them
    // reinforced and graduates them into the skills registry. The curator
    // stack grants itself access. Items are keyed by area_bucket and
    // record_id; agents/curator/src/tools/concerns-ddb.ts defines the rest.
    this.concernsTable = new dynamodb.Table(this, 'ConcernsTable', {
      tableName: props.agentId.replace(/-/g, '_') + '_concerns',
      partitionKey: { name: 'area_bucket', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'record_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.substrateKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The reviewer runs code from the pull request, so its role holds no
    // secrets and has no Secrets Manager, concerns-table or registry-write
    // access. Its only writes are its own logs, the heartbeat table and,
    // through the token broker, the pull request. The ready-label Lambda,
    // when granted, mints its own token and never returns it.
    const runtimeName = props.agentId.replace(/-/g, '_') + '_runtime';
    this.role = createRuntimeRole(this, 'RuntimeRole', {
      description: `Execution role for the ${props.agentId} runtime.`,
      image,
      runtimeName,
    });
    // Its prompt and skill: objects under its own prefix, no bucket
    // listing. The bucket is encrypted with the substrate key.
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadAgentAssets',
      actions: ['s3:GetObject'],
      resources: [props.assetsBucket.arnForObjects(`${props.agentId}/*`)],
    }));
    props.substrateKey.grantDecrypt(this.role);
    props.heartbeatTable.grant(this.role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    props.tokenBroker.grantInvoke(this.role);
    props.readyLabelFunction?.grantInvoke(this.role);
    const m = props.models;
    for (const statement of modelAccessStatements(this, [
      m.reviewer.primary, m.reviewer.fallback, m.summarizer.primary, m.summarizer.fallback, ...m.extraGrants,
    ], m)) {
      this.role.addToPrincipalPolicy(statement);
    }
    // Reviewers list and fetch records directly; record approval status
    // is not used as a gate.
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadSkillsRegistry',
      actions: ['agent-registry:GetRegistryRecord', 'agent-registry:ListRegistryRecords'],
      resources: registryResources(this, props.skillsRegistry),
    }));

    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: runtimeName,
      description: props.description,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: image.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: SESSION_IDLE_TIMEOUT_SECONDS,
        maxLifetime: SESSION_MAX_LIFETIME_SECONDS,
      },
      roleArn: this.role.roleArn,
      environmentVariables: {
        BEDROCK_MODEL_ID: m.reviewer.primary,
        FALLBACK_MODEL_ID: m.reviewer.fallback,
        REASONING_EFFORT: m.reviewer.effort,
        MANTLE_REGION: m.mantleRegion || this.region,
        SUMMARIZER_MODEL_ID: m.summarizer.primary,
        SUMMARIZER_FALLBACK_MODEL_ID: m.summarizer.fallback,
        AWS_REGION: this.region,
        ASSETS_BUCKET: props.assetsBucket.bucketName,
        PROMPT_S3_KEY: promptKey,
        SKILL_S3_KEY: skillKey,
        GITHUB_APP_ID: props.githubAppId,
        TOKEN_BROKER_FUNCTION: props.tokenBroker.functionName,
        ...(props.readyLabelFunction ? { READY_LABEL_FUNCTION: props.readyLabelFunction.functionName } : {}),
        SKILLS_REGISTRY_ID: props.skillsRegistry,
        HEARTBEAT_TABLE: props.heartbeatTable.tableName,
        MAX_ITERATIONS: String(props.agent.maxIterations),
        MAX_TOKENS: String(props.agent.maxTokens),
        WORKSPACE_ROOT: props.workspaceRoot,
        ALLOW_WRITE: String(props.agent.allowWrite),
        ALLOW_BUILD: String(props.agent.allowBuild),
        UPSTREAM_REPO: props.upstreamRepo,
      },
    });
    // The service checks image access when it creates the runtime, so the
    // role's policies must exist first.
    this.runtime.node.addDependency(this.role);

    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: this.runtime.attrAgentRuntimeArn,
      description: `AgentCore Runtime ARN for ${props.agentId}.`,
    });
    new cdk.CfnOutput(this, 'RuntimeId', { value: this.runtime.attrAgentRuntimeId });
    new cdk.CfnOutput(this, 'ConcernsTableName', { value: this.concernsTable.tableName });
    new cdk.CfnOutput(this, 'SkillsRegistryId', { value: props.skillsRegistry });
    new cdk.CfnOutput(this, 'ImageUri', { value: image.imageUri });
  }
}
