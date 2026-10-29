import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { CuratorAgentStack } from './curator-agent-stack';
import { DecayCronStack } from './decay-cron-stack';
import { type DeploymentConfig, REVIEWER_IDS, type ReviewerId, readyLabelsByRepo, tokenBrokerRepos } from './deployment-config';
import { SubstrateStack } from './substrate-stack';
import { ValkeyReviewAgentStack } from './valkey-review-agent-stack';
import { WebhookStack } from './webhook-stack';

/** Per-reviewer facts that come from the code, not from deployment configuration. */
const REVIEWERS: Readonly<Record<ReviewerId, { stackId: string; workspaceRoot: string; description: string }>> = {
  'valkey-review': {
    stackId: 'ValkeyReviewAgent',
    workspaceRoot: '/workspace/valkey',
    description: 'valkey-review: pull request reviewer for Valkey.',
  },
  'valkey-glide-review': {
    stackId: 'ValkeyGlideReviewAgent',
    workspaceRoot: '/workspace/valkey-glide',
    description: 'valkey-glide-review: pull request reviewer for Valkey GLIDE (Rust core with Java, Python, Node and Go bindings).',
  },
};

export interface ValkeyReviewerStacks {
  readonly substrate: SubstrateStack;
  readonly reviewers: ReadonlyMap<ReviewerId, ValkeyReviewAgentStack>;
  readonly curator: CuratorAgentStack;
  readonly webhook: WebhookStack;
  readonly decay: DecayCronStack;
}

/** Adds every valkey-reviewer stack to `app`. Stack ids are stable across updates. */
export function addValkeyReviewerStacks(
  app: cdk.App,
  config: DeploymentConfig,
  repoRoot: string = path.join(__dirname, '..', '..'),
): ValkeyReviewerStacks {
  const common = (): cdk.StackProps => ({
    env: { account: config.aws.account, region: config.aws.region },
    synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: config.aws.bootstrapQualifier }),
  });

  const readyLabels = readyLabelsByRepo(config);
  const substrate = new SubstrateStack(app, 'ValkeyReviewerSubstrate', {
    ...common(),
    description: 'valkey-reviewer shared resources: assets bucket, KMS key, GitHub token broker and run heartbeat table.',
    github: config.github,
    allowedRepos: Object.fromEntries(REVIEWER_IDS.map((r) => [r, tokenBrokerRepos(config, r)])) as Record<ReviewerId, string[]>,
    ...(config.skillsRepo ? { skillsRepo: config.skillsRepo } : {}),
    ...(Object.keys(readyLabels).length > 0 ? { readyLabels } : {}),
  });

  const reviewers = new Map<ReviewerId, ValkeyReviewAgentStack>();
  for (const reviewerId of REVIEWER_IDS) {
    const facts = REVIEWERS[reviewerId];
    const agentRoot = path.join(repoRoot, 'agents', reviewerId);
    reviewers.set(reviewerId, new ValkeyReviewAgentStack(app, facts.stackId, {
      ...common(),
      agentId: reviewerId,
      description: facts.description,
      agentSourcePath: repoRoot,
      dockerfile: `agents/${reviewerId}/Dockerfile`,
      workspaceRoot: facts.workspaceRoot,
      skillPath: path.join(agentRoot, 'config', 'skill.md'),
      promptPath: path.join(agentRoot, 'config', 'prompt.md'),
      assetsBucket: substrate.assetsBucket,
      substrateKey: substrate.key,
      heartbeatTable: substrate.heartbeatTable,
      tokenBroker: substrate.tokenBrokers.get(reviewerId)!,
      ...(substrate.readyLabelFn ? { readyLabelFunction: substrate.readyLabelFn } : {}),
      githubAppId: config.github.appId,
      skillsRegistry: config.skillsRegistries[reviewerId],
      upstreamRepo: config.upstreamRepos[reviewerId],
      agent: config.agents[reviewerId],
      models: config.models,
    }));
  }
  const reviewer = (reviewerId: ReviewerId) => reviewers.get(reviewerId)!;
  const concernsTables = new Map(REVIEWER_IDS.map((r) => [r, reviewer(r).concernsTable] as const));

  const curatorRoot = path.join(repoRoot, 'agents', 'curator');
  const curator = new CuratorAgentStack(app, 'ValkeyReviewerCurator', {
    ...common(),
    description: 'valkey-reviewer curator: turns maintainer feedback into concerns and graduated reviewer skills, and checks and retires those skills.',
    agentSourcePath: repoRoot,
    promptPath: path.join(curatorRoot, 'config', 'prompt.md'),
    skillPath: path.join(curatorRoot, 'config', 'skill.md'),
    checkPromptPath: path.join(curatorRoot, 'config', 'skill-check.md'),
    assetsBucket: substrate.assetsBucket,
    concernsTables,
    skillsRegistries: new Map(REVIEWER_IDS.map((r) => [r, config.skillsRegistries[r]] as const)),
    curatorSkillsRegistry: config.skillsRegistries.curator,
    agent: config.agents.curator,
    models: config.models,
    upstreamRepos: config.upstreamRepos,
    skillLifecycle: config.skillLifecycle,
    ...(config.skillsRepo && substrate.skillsRepoTokenBroker
      ? { skillsRepo: { config: config.skillsRepo, tokenBroker: substrate.skillsRepoTokenBroker } }
      : {}),
  });

  const webhook = new WebhookStack(app, 'ValkeyReviewWebhook', {
    ...common(),
    description: 'valkey-reviewer GitHub App webhook: routes pull request events to the reviewers and feedback to the curator.',
    githubAppSecret: substrate.githubAppSecret,
    github: config.github,
    heartbeatTable: substrate.heartbeatTable,
    routes: config.routes.map((route) => ({ ...route, runtimeArn: reviewer(route.reviewer).runtime.attrAgentRuntimeArn })),
    curatorOnlyRoutes: config.curatorOnlyRoutes,
    curatorRuntimeArn: curator.runtime.attrAgentRuntimeArn,
    models: config.models,
    dailyReviewBudget: config.dailyReviewBudget,
    maxAutomaticReviewsPerPr: config.maxAutomaticReviewsPerPr,
    pushReviewDelaySeconds: config.pushReviewDelaySeconds,
    ...(substrate.readyLabelFn ? { readyLabelFunction: substrate.readyLabelFn } : {}),
  });

  // Created after the webhook stack, whose curator queue it sends to.
  const decay = new DecayCronStack(app, 'ValkeyReviewerDecay', {
    ...common(),
    description: 'valkey-reviewer daily concerns decay and skill maintenance scheduling.',
    concernsTables,
    decay: config.decay,
    curatorQueue: webhook.curatorQueue,
    upstreamRepos: config.upstreamRepos,
    skillLifecycle: config.skillLifecycle,
  });

  return { substrate, reviewers, curator, webhook, decay };
}
