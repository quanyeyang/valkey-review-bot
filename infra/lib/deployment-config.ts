import * as fs from 'node:fs';
import * as path from 'node:path';
import { RegionInfo } from 'aws-cdk-lib/region-info';

/**
 * Deployment configuration: everything that differs between one
 * installation and another (account, GitHub App, registries, routes,
 * models). The real file is infra/deploy.config.json and is not committed;
 * infra/deploy.config.example.json shows the shape. infra/README.md
 * documents every key.
 */

export const REVIEWER_IDS = ['valkey-review', 'valkey-glide-review'] as const;
export type ReviewerId = (typeof REVIEWER_IDS)[number];

/** Effort levels both providers accept (Bedrock Converse output_config and Mantle reasoning). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AwsConfig {
  readonly account: string;
  readonly region: string;
  readonly bootstrapQualifier: string;
}

export interface GitHubConfig {
  readonly appId: string;
  readonly botLogin: string;
  /** Secrets Manager secret holding the App's private_key, app_id and webhook_secret. */
  readonly appSecretName: string;
  /** Used only when a webhook payload carries no installation id. */
  readonly installationId?: string;
  /** Replaces the receiver's built-in list of third-party bot logins. An empty list keeps the built-in one. */
  readonly knownBotLogins?: readonly string[];
}

export type SkillsRegistries = Readonly<Record<ReviewerId | 'curator', string>>;

export interface RouteConfig {
  readonly id: string;
  readonly reviewer: ReviewerId;
  readonly repo: string;
  readonly threadReplyReview: boolean;
  readonly skipDrafts: boolean;
  readonly mentionOnly: boolean;
  readonly authorAllowlist: readonly string[];
  /**
   * GitHub label this route projects readiness onto. Absent or empty
   * turns the feature off for the route. The operator creates the label
   * in the repository; the bot never does.
   */
  readonly readyLabel?: string;
}

export interface CuratorOnlyRouteConfig {
  readonly reviewer: ReviewerId;
  readonly repo: string;
}

export interface ModelsConfig {
  readonly reviewer: { readonly primary: string; readonly fallback: string; readonly effort: Effort };
  readonly curator: {
    readonly primary: string;
    readonly fallback: string;
    readonly effort: Effort;
    readonly fallbackEffort: Effort;
  };
  readonly summarizer: { readonly primary: string; readonly fallback: string };
  readonly safetyGate: string;
  /**
   * Regions a cross-Region inference profile may route a request to. Each
   * gets a foundation-model grant.
   */
  readonly profileRegions: readonly string[];
  /** Region the Mantle (openai.*) client calls. Empty when no openai.* model is configured. */
  readonly mantleRegion: string;
  readonly mantleGrantRegions: readonly string[];
  /** More model IDs to grant to the reviewer and curator roles, for example a model to roll back to. */
  readonly extraGrants: readonly string[];
}

export interface ReviewerAgentConfig {
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly allowBuild: boolean;
  readonly allowWrite: boolean;
}

export interface CuratorAgentConfig {
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly graduationThreshold: number;
}

export type AgentsConfig = Readonly<Record<ReviewerId, ReviewerAgentConfig>> & {
  readonly curator: CuratorAgentConfig;
};

export interface DecayConfig {
  /** Half-life of concern records that never graduated into a skill. */
  readonly halfLifeDays: number;
  readonly floor: number;
  /** Half-life of records that graduated into a skill: their skill's standing. */
  readonly graduatedHalfLifeDays: number;
}

/**
 * Skill maintenance: the release checks and retirements the decay job
 * schedules and the curator runs. Every switch that changes a skill,
 * retires one or opens a pull request is off by default (report mode).
 */
export interface SkillLifecycleConfig {
  /** Check requests per reviewer per daily pass; 0 turns checks off. */
  readonly checksPerDay: number;
  /** A check is also due when the last one is older than this. */
  readonly recheckDays: number;
  /** Write validated edits to registry skills. Off: they are kept for the operator. */
  readonly applyEdits: boolean;
  /** Deprecate skills that decayed below the floor or whose subject is gone. Off: logged as would-retire. */
  readonly retireSkills: boolean;
  /** Propose repo skill edits by pull request against skillsRepo. Off: report only. */
  readonly openPullRequests: boolean;
  /** Retire requests per reviewer per daily pass. */
  readonly maxRetirementsPerDay: number;
  /** Tool rounds of one audit. */
  readonly maxCheckRounds: number;
  /** A record whose retirement the curator refused is not requested again for this long. */
  readonly retireRefusedBackoffDays: number;
}

/** The bot's own repository, where the reviewers' repo skill files live. */
export interface SkillsRepoConfig {
  /** "owner/name". */
  readonly repo: string;
  readonly baseBranch: string;
  /** Secrets Manager secret of the GitHub App that opens the pull requests; github.appSecretName by default. */
  readonly appSecretName: string;
  /** "Name <email>" for the commit's Signed-off-by line; the App's bot identity when unset. */
  readonly signOff?: string;
}

export interface DeploymentConfig {
  readonly aws: AwsConfig;
  readonly github: GitHubConfig;
  readonly skillsRegistries: SkillsRegistries;
  readonly routes: readonly RouteConfig[];
  readonly curatorOnlyRoutes: readonly CuratorOnlyRouteConfig[];
  readonly upstreamRepos: Readonly<Record<ReviewerId, string>>;
  readonly models: ModelsConfig;
  readonly agents: AgentsConfig;
  readonly decay: DecayConfig;
  readonly skillLifecycle: SkillLifecycleConfig;
  /** Absent: repo skill findings are only reported. */
  readonly skillsRepo?: SkillsRepoConfig;
  readonly dailyReviewBudget: number;
  /** Automatic reviews per pull request, counting the first. Mentions and thread replies are not counted. */
  readonly maxAutomaticReviewsPerPr: number;
  /** SQS delay of a review that new commits start, so a burst of pushes becomes one review. */
  readonly pushReviewDelaySeconds: number;
}

const DEFAULT_PRIMARY = 'us.anthropic.claude-opus-5-5';
const DEFAULT_FALLBACK = 'openai.gpt-6.1-sol';

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+){1,2}-\d{1,2}$/;
const DIGITS = /^\d{1,20}$/;
const REGISTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOOTSTRAP_QUALIFIER = /^[a-z0-9]{1,10}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
/** "owner/name"; the decay job, the curator and the brokers refuse a name of "." or "..". */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const ROUTE_ID = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
const MODEL_ID = /^[a-z0-9-]+\.[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
/**
 * A branch name both the curator's config check and its pull request
 * code accept (agents/curator/src/config.ts and repo-skill-pr.ts).
 */
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)(?!.*\.lock\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/**
 * "Name <email>" on one line, as both the curator's config check and its
 * pull request code accept it: no control characters, a name of at most
 * 100 characters that neither starts nor ends with a space.
 */
const SIGN_OFF = /^(?! )[^<>\x00-\x1f\x7f]{0,99}[^<>\x00-\x1f\x7f ] <[^<>\s@]{1,64}@[^<>\s@]{1,190}>$/;

export interface ProfileGeography {
  /** The regions the group can contain, for error messages. */
  readonly regions: string;
  /** Whether a region can belong to the group, judged from its name. */
  readonly covers: (region: string) => boolean;
}

const regionsStartingWith = (prefix: string, regions: string): ProfileGeography => ({
  regions,
  covers: (region) => region.startsWith(prefix),
});

/**
 * Cross-Region inference profile prefixes. A profile ID is one of these
 * region-group tokens, a dot and a foundation model ID, for example
 * jp.anthropic.claude-haiku-5-5. Any other first token is a model
 * provider, so an ID such as anthropic.claude-haiku-5-5 is a foundation
 * model.
 *
 * Bedrock decides the exact source and destination regions per profile
 * and per source region, so `covers` only rules out regions whose names
 * place them outside the group. global.* can route to any commercial
 * region and has no entry here.
 */
export const PROFILE_GEOGRAPHIES: Readonly<Record<string, ProfileGeography>> = {
  us: { regions: 'a us-* region outside GovCloud', covers: (region) => region.startsWith('us-') && !region.startsWith('us-gov-') },
  'us-gov': regionsStartingWith('us-gov-', 'a us-gov-* region'),
  eu: regionsStartingWith('eu-', 'an eu-* region'),
  apac: regionsStartingWith('ap-', 'an ap-* region'),
  jp: regionsStartingWith('ap-', 'an ap-* region'),
  au: regionsStartingWith('ap-', 'an ap-* region'),
  'in': regionsStartingWith('ap-', 'an ap-* region'),
  ca: regionsStartingWith('ca-', 'a ca-* region'),
};

/** The region-group token of a cross-Region inference profile ID, such as "us" or "global"; undefined for any other ID. */
export function inferenceProfileGroup(modelId: string): string | undefined {
  const first = modelId.split('.')[0]!;
  return first === 'global' || Object.hasOwn(PROFILE_GEOGRAPHIES, first) ? first : undefined;
}

/** Collects every problem in one pass so the operator can fix them together. */
class Reader {
  readonly problems: string[] = [];

  fail(at: string, message: string): void {
    this.problems.push(`${at} ${message}`);
  }

  object(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(at, 'must be an object');
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) this.fail(`${at}.${key}`, 'is not a known setting');
    }
    return value as Record<string, unknown>;
  }

  string(value: unknown, at: string, rule: { pattern?: RegExp; hint?: string; fallback?: string; allowEmpty?: boolean }): string {
    if (value === undefined && rule.fallback !== undefined) return rule.fallback;
    if (value === undefined) {
      this.fail(at, 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      this.fail(at, 'must be a string');
      return '';
    }
    if (value === '' && rule.allowEmpty) return value;
    if (value === '' || (rule.pattern && !rule.pattern.test(value))) {
      this.fail(at, `must be ${rule.hint ?? `a string matching ${rule.pattern}`} (got ${JSON.stringify(value)})`);
    }
    return value;
  }

  number(value: unknown, at: string, rule: { fallback: number; min: number; max: number; integer: boolean; minExclusive?: boolean; maxExclusive?: boolean }): number {
    if (value === undefined) return rule.fallback;
    const ok = typeof value === 'number' && Number.isFinite(value)
      && (!rule.integer || Number.isInteger(value))
      && (rule.minExclusive ? value > rule.min : value >= rule.min)
      && (rule.maxExclusive ? value < rule.max : value <= rule.max);
    if (!ok) {
      const lo = rule.minExclusive ? `> ${rule.min}` : `>= ${rule.min}`;
      const hi = rule.maxExclusive ? `< ${rule.max}` : `<= ${rule.max}`;
      this.fail(at, `must be ${rule.integer ? 'an integer' : 'a number'} ${lo} and ${hi} (got ${JSON.stringify(value)})`);
      return rule.fallback;
    }
    return value as number;
  }

  boolean(value: unknown, at: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.fail(at, 'must be true or false');
      return fallback;
    }
    return value;
  }

  array(value: unknown, at: string, fallback: readonly unknown[] | undefined): readonly unknown[] {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Array.isArray(value)) {
      this.fail(at, value === undefined ? 'is required' : 'must be an array');
      return [];
    }
    return value;
  }

  strings(value: unknown, at: string, rule: { pattern: RegExp; hint: string; fallback?: readonly string[] }): string[] {
    return this.array(value, at, rule.fallback)
      .map((v, i) => this.string(v, `${at}[${i}]`, { pattern: rule.pattern, hint: rule.hint }));
  }

  oneOf<T extends string>(value: unknown, at: string, choices: readonly T[], fallback?: T): T {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
      this.fail(at, `must be one of ${choices.join(', ')} (got ${JSON.stringify(value)})`);
      return fallback ?? choices[0]!;
    }
    return value as T;
  }
}

/** ARN partition for a region, e.g. aws-cn for cn-north-1. */
export function partitionOf(region: string): string {
  return RegionInfo.get(region).partition ?? 'aws';
}

/** Throws one error that lists every problem found in `raw`. */
export function parseDeploymentConfig(raw: unknown, env: { readonly CDK_DEFAULT_ACCOUNT?: string } = {}): DeploymentConfig {
  const r = new Reader();
  const top = r.object(raw, 'config', [
    'aws', 'github', 'skillsRegistries', 'routes', 'curatorOnlyRoutes', 'upstreamRepos',
    'models', 'agents', 'decay', 'skillLifecycle', 'skillsRepo',
    'dailyReviewBudget', 'maxAutomaticReviewsPerPr', 'pushReviewDelaySeconds',
  ]);
  if (raw === undefined) r.fail('config', 'is empty');

  const awsRaw = r.object(top.aws, 'aws', ['account', 'region', 'bootstrapQualifier']);
  if (top.aws === undefined) r.fail('aws', 'is required');
  const aws: AwsConfig = {
    account: r.string(awsRaw.account, 'aws.account', { pattern: ACCOUNT, hint: 'a 12-digit AWS account ID' }),
    region: r.string(awsRaw.region, 'aws.region', { pattern: REGION, hint: 'an AWS region such as us-west-2' }),
    bootstrapQualifier: r.string(awsRaw.bootstrapQualifier, 'aws.bootstrapQualifier', {
      pattern: BOOTSTRAP_QUALIFIER, hint: 'a CDK bootstrap qualifier (up to 10 lowercase letters or digits)', fallback: 'hnb659fds',
    }),
  };
  const cliAccount = env.CDK_DEFAULT_ACCOUNT?.trim();
  if (cliAccount && ACCOUNT.test(aws.account) && cliAccount !== aws.account) {
    r.fail('aws.account', `is ${aws.account} but the current AWS credentials are for account ${cliAccount}`);
  }
  const partition = REGION.test(aws.region) ? partitionOf(aws.region) : 'aws';

  const ghRaw = r.object(top.github, 'github', ['appId', 'botLogin', 'appSecretName', 'installationId', 'knownBotLogins']);
  if (top.github === undefined) r.fail('github', 'is required');
  const botLogin = r.string(ghRaw.botLogin, 'github.botLogin', { pattern: LOGIN, hint: 'the App bot login, ending in [bot]' });
  if (botLogin && !botLogin.endsWith('[bot]')) r.fail('github.botLogin', `must end with [bot] (got ${JSON.stringify(botLogin)})`);
  const github: GitHubConfig = {
    appId: r.string(ghRaw.appId, 'github.appId', { pattern: DIGITS, hint: 'the numeric GitHub App ID' }),
    botLogin,
    appSecretName: r.string(ghRaw.appSecretName, 'github.appSecretName', { pattern: SECRET_NAME, hint: 'a Secrets Manager secret name' }),
    ...(ghRaw.installationId === undefined ? {} : {
      installationId: r.string(ghRaw.installationId, 'github.installationId', { pattern: DIGITS, hint: 'a numeric installation ID' }),
    }),
    ...(ghRaw.knownBotLogins === undefined ? {} : {
      knownBotLogins: r.strings(ghRaw.knownBotLogins, 'github.knownBotLogins', { pattern: LOGIN, hint: 'a GitHub login' }),
    }),
  };

  const regRaw = r.object(top.skillsRegistries, 'skillsRegistries', [...REVIEWER_IDS, 'curator']);
  if (top.skillsRegistries === undefined) r.fail('skillsRegistries', 'is required');
  const registry = (key: ReviewerId | 'curator'): string => {
    const at = `skillsRegistries.${key}`;
    const value = r.string(regRaw[key], at, { hint: 'a registry ID or ARN' });
    if (!value || REGISTRY_ID.test(value)) return value;
    const arn = /^arn:([a-z-]+):agent-registry:([a-z0-9-]+):(\d{12}):registry\/([A-Za-z0-9_-]{1,64})$/.exec(value);
    if (!arn) {
      r.fail(at, `must be a registry ID (letters, digits, _ or -) or an agent-registry registry ARN (got ${JSON.stringify(value)})`);
    } else if (arn[1] !== partition || arn[2] !== aws.region || arn[3] !== aws.account) {
      r.fail(at, `must be in partition ${partition}, region ${aws.region} and account ${aws.account} (got ${value})`);
    }
    return value;
  };
  const skillsRegistries: SkillsRegistries = {
    'valkey-review': registry('valkey-review'),
    'valkey-glide-review': registry('valkey-glide-review'),
    curator: registry('curator'),
  };

  const routes: RouteConfig[] = r.array(top.routes, 'routes', undefined).map((value, i) => {
    const at = `routes[${i}]`;
    const o = r.object(value, at, ['id', 'reviewer', 'repo', 'threadReplyReview', 'skipDrafts', 'mentionOnly', 'authorAllowlist', 'readyLabel']);
    const readyLabel = readyLabelOf(r, o.readyLabel, `${at}.readyLabel`);
    return {
      id: r.string(o.id, `${at}.id`, { pattern: ROUTE_ID, hint: 'letters, digits and hyphens' }),
      reviewer: r.oneOf(o.reviewer, `${at}.reviewer`, REVIEWER_IDS),
      repo: r.string(o.repo, `${at}.repo`, { pattern: REPO, hint: 'owner/name' }),
      threadReplyReview: r.boolean(o.threadReplyReview, `${at}.threadReplyReview`, false),
      skipDrafts: r.boolean(o.skipDrafts, `${at}.skipDrafts`, false),
      mentionOnly: r.boolean(o.mentionOnly, `${at}.mentionOnly`, false),
      authorAllowlist: r.strings(o.authorAllowlist, `${at}.authorAllowlist`, { pattern: LOGIN, hint: 'a GitHub login', fallback: [] }),
      ...(readyLabel ? { readyLabel } : {}),
    };
  });
  if (Array.isArray(top.routes) && routes.length === 0) r.fail('routes', 'must list at least one route');

  const curatorOnlyRoutes: CuratorOnlyRouteConfig[] = r.array(top.curatorOnlyRoutes, 'curatorOnlyRoutes', []).map((value, i) => {
    const at = `curatorOnlyRoutes[${i}]`;
    const o = r.object(value, at, ['reviewer', 'repo']);
    return {
      reviewer: r.oneOf(o.reviewer, `${at}.reviewer`, REVIEWER_IDS),
      repo: r.string(o.repo, `${at}.repo`, { pattern: REPO, hint: 'owner/name' }),
    };
  });

  // Route ids become CDK construct ids with non-alphanumerics removed,
  // so they must stay unique after that step too.
  const seenIds = new Map<string, string>();
  routes.forEach((route, i) => {
    if (!route.id) return;
    const key = route.id.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const prior = seenIds.get(key);
    if (prior !== undefined) r.fail(`routes[${i}].id`, `${JSON.stringify(route.id)} collides with route ${JSON.stringify(prior)}`);
    else seenIds.set(key, route.id);
  });
  // The receiver looks routes up by repository, so a repository can have one route.
  const seenRepos = new Map<string, string>();
  const claimRepo = (repo: string, at: string) => {
    if (!repo) return;
    const prior = seenRepos.get(repo.toLowerCase());
    if (prior !== undefined) r.fail(at, `repeats repository ${repo} (already used by ${prior})`);
    else seenRepos.set(repo.toLowerCase(), at);
  };
  routes.forEach((route, i) => claimRepo(route.repo, `routes[${i}].repo`));
  curatorOnlyRoutes.forEach((route, i) => claimRepo(route.repo, `curatorOnlyRoutes[${i}].repo`));

  const upRaw = r.object(top.upstreamRepos, 'upstreamRepos', [...REVIEWER_IDS]);
  const upstreamRepos: Record<ReviewerId, string> = {
    'valkey-review': r.string(upRaw['valkey-review'], 'upstreamRepos.valkey-review', {
      pattern: REPO, hint: 'owner/name, or empty to use the pull request repository', fallback: 'valkey-io/valkey', allowEmpty: true,
    }),
    'valkey-glide-review': r.string(upRaw['valkey-glide-review'], 'upstreamRepos.valkey-glide-review', {
      pattern: REPO, hint: 'owner/name, or empty to use the pull request repository', fallback: 'valkey-io/valkey-glide', allowEmpty: true,
    }),
  };

  const models = parseModels(r, top.models, aws.region);
  const agents = parseAgents(r, top.agents);

  const decay = parseDecay(r, top.decay);
  const skillLifecycle = parseSkillLifecycle(r, top.skillLifecycle);
  const skillsRepo = top.skillsRepo === undefined ? undefined : parseSkillsRepo(r, top.skillsRepo, github.appSecretName);
  if (skillLifecycle.openPullRequests && skillsRepo === undefined) {
    r.fail('skillLifecycle.openPullRequests', 'is true but skillsRepo is not set, so there is no repository to open pull requests against');
  }

  const dailyReviewBudget = r.number(top.dailyReviewBudget, 'dailyReviewBudget', { fallback: 40, min: 0, max: 10_000, integer: true });
  // The receiver enforces the same ranges (webhook/src/config.ts); SQS
  // allows a per-message delay of at most 900 seconds.
  const maxAutomaticReviewsPerPr = r.number(top.maxAutomaticReviewsPerPr, 'maxAutomaticReviewsPerPr', { fallback: 3, min: 1, max: 20, integer: true });
  const pushReviewDelaySeconds = r.number(top.pushReviewDelaySeconds, 'pushReviewDelaySeconds', { fallback: 300, min: 0, max: 900, integer: true });

  if (r.problems.length > 0) {
    throw new Error(`Invalid deployment configuration:\n  - ${[...new Set(r.problems)].join('\n  - ')}`);
  }
  return {
    aws, github, skillsRegistries, routes, curatorOnlyRoutes, upstreamRepos, models, agents, decay, skillLifecycle,
    ...(skillsRepo ? { skillsRepo } : {}),
    dailyReviewBudget, maxAutomaticReviewsPerPr, pushReviewDelaySeconds,
  };
}

const HALF_LIFE_DAYS = { min: 0, max: 3650, integer: false, minExclusive: true } as const;

function parseDecay(r: Reader, value: unknown): DecayConfig {
  const o = r.object(value, 'decay', ['halfLifeDays', 'floor', 'graduatedHalfLifeDays']);
  const decay: DecayConfig = {
    halfLifeDays: r.number(o.halfLifeDays, 'decay.halfLifeDays', { fallback: 30, ...HALF_LIFE_DAYS }),
    floor: r.number(o.floor, 'decay.floor', { fallback: 0.05, min: 0, max: 1, integer: false, minExclusive: true, maxExclusive: true }),
    graduatedHalfLifeDays: r.number(o.graduatedHalfLifeDays, 'decay.graduatedHalfLifeDays', { fallback: 180, ...HALF_LIFE_DAYS }),
  };
  // A skill must not lose standing faster than the concerns it came from.
  // Checked only on values that passed their own range check, so one
  // typo gives one problem.
  const rangeOk = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3650);
  if (rangeOk(o.halfLifeDays) && rangeOk(o.graduatedHalfLifeDays) && decay.graduatedHalfLifeDays < decay.halfLifeDays) {
    r.fail('decay.graduatedHalfLifeDays', `must be at least decay.halfLifeDays (got ${decay.graduatedHalfLifeDays} and ${decay.halfLifeDays})`);
  }
  return decay;
}

function parseSkillLifecycle(r: Reader, value: unknown): SkillLifecycleConfig {
  const o = r.object(value, 'skillLifecycle', [
    'checksPerDay', 'recheckDays', 'applyEdits', 'retireSkills', 'openPullRequests',
    'maxRetirementsPerDay', 'maxCheckRounds', 'retireRefusedBackoffDays',
  ]);
  const at = (key: string) => `skillLifecycle.${key}`;
  return {
    checksPerDay: r.number(o.checksPerDay, at('checksPerDay'), { fallback: 10, min: 0, max: 100, integer: true }),
    recheckDays: r.number(o.recheckDays, at('recheckDays'), { fallback: 90, min: 7, max: 3650, integer: true }),
    applyEdits: r.boolean(o.applyEdits, at('applyEdits'), false),
    retireSkills: r.boolean(o.retireSkills, at('retireSkills'), false),
    openPullRequests: r.boolean(o.openPullRequests, at('openPullRequests'), false),
    maxRetirementsPerDay: r.number(o.maxRetirementsPerDay, at('maxRetirementsPerDay'), { fallback: 3, min: 1, max: 50, integer: true }),
    // The curator rejects values outside 5..100 at boot (CHECK_MAX_ROUNDS).
    maxCheckRounds: r.number(o.maxCheckRounds, at('maxCheckRounds'), { fallback: 25, min: 5, max: 100, integer: true }),
    retireRefusedBackoffDays: r.number(o.retireRefusedBackoffDays, at('retireRefusedBackoffDays'), { fallback: 30, min: 1, max: 3650, integer: true }),
  };
}

function parseSkillsRepo(r: Reader, value: unknown, defaultSecretName: string): SkillsRepoConfig {
  const o = r.object(value, 'skillsRepo', ['repo', 'baseBranch', 'appSecretName', 'signOff']);
  const signOff = o.signOff === undefined ? undefined : r.string(o.signOff, 'skillsRepo.signOff', {
    pattern: SIGN_OFF, hint: 'one line of the form "Name <email>"',
  });
  // The curator trims the value and checks it again at boot; a name that is
  // only Unicode whitespace would pass SIGN_OFF here and stop it from booting.
  const signOffName = signOff === undefined ? '' : signOff.slice(0, signOff.lastIndexOf(' <'));
  if (signOff !== undefined && (signOffName.trim() !== signOffName || signOffName.trim() === '')) {
    r.fail('skillsRepo.signOff', 'has whitespace at either end of the name, or a name that is only whitespace');
  }
  return {
    repo: r.string(o.repo, 'skillsRepo.repo', { pattern: REPO, hint: 'owner/name of the bot repository' }),
    baseBranch: r.string(o.baseBranch, 'skillsRepo.baseBranch', { pattern: BRANCH, hint: 'a branch name', fallback: 'main' }),
    appSecretName: r.string(o.appSecretName, 'skillsRepo.appSecretName', {
      pattern: SECRET_NAME, hint: 'a Secrets Manager secret name', fallback: defaultSecretName,
    }),
    ...(signOff === undefined ? {} : { signOff }),
  };
}

function parseModels(r: Reader, value: unknown, region: string): ModelsConfig {
  const o = r.object(value, 'models', [
    'reviewer', 'curator', 'summarizer', 'safetyGate', 'profileRegions', 'mantleRegion', 'mantleGrantRegions', 'extraGrants',
  ]);
  const model = (v: unknown, at: string, fallback: string) =>
    r.string(v, at, { pattern: MODEL_ID, hint: 'a Bedrock model or inference profile ID', fallback });

  const rv = r.object(o.reviewer, 'models.reviewer', ['primary', 'fallback', 'effort']);
  const cu = r.object(o.curator, 'models.curator', ['primary', 'fallback', 'effort', 'fallbackEffort']);
  const su = r.object(o.summarizer, 'models.summarizer', ['primary', 'fallback']);
  const mantleRegion = r.string(o.mantleRegion, 'models.mantleRegion', {
    pattern: REGION, hint: 'an AWS region, or empty when no openai.* model is configured', fallback: 'us-east-1', allowEmpty: true,
  });
  const regions = (v: unknown, at: string, fallback: readonly string[]) =>
    r.strings(v, at, { pattern: REGION, hint: 'an AWS region', fallback });

  const models: ModelsConfig = {
    reviewer: {
      primary: model(rv.primary, 'models.reviewer.primary', DEFAULT_PRIMARY),
      fallback: model(rv.fallback, 'models.reviewer.fallback', DEFAULT_FALLBACK),
      effort: r.oneOf(rv.effort, 'models.reviewer.effort', EFFORTS, 'high'),
    },
    curator: {
      primary: model(cu.primary, 'models.curator.primary', DEFAULT_PRIMARY),
      fallback: model(cu.fallback, 'models.curator.fallback', DEFAULT_FALLBACK),
      effort: r.oneOf(cu.effort, 'models.curator.effort', EFFORTS, 'medium'),
      fallbackEffort: r.oneOf(cu.fallbackEffort, 'models.curator.fallbackEffort', EFFORTS, 'high'),
    },
    summarizer: {
      primary: model(su.primary, 'models.summarizer.primary', 'us.anthropic.claude-haiku-5-5'),
      fallback: model(su.fallback, 'models.summarizer.fallback', DEFAULT_FALLBACK),
    },
    safetyGate: model(o.safetyGate, 'models.safetyGate', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    profileRegions: regions(o.profileRegions, 'models.profileRegions', ['us-east-1', 'us-east-2', 'us-west-2']),
    mantleRegion,
    mantleGrantRegions: regions(o.mantleGrantRegions, 'models.mantleGrantRegions', mantleRegion ? [mantleRegion] : []),
    extraGrants: r.strings(o.extraGrants, 'models.extraGrants', { pattern: MODEL_ID, hint: 'a Bedrock model or inference profile ID', fallback: [] }),
  };

  const all: [string, string][] = [
    ['models.reviewer.primary', models.reviewer.primary],
    ['models.reviewer.fallback', models.reviewer.fallback],
    ['models.curator.primary', models.curator.primary],
    ['models.curator.fallback', models.curator.fallback],
    ['models.summarizer.primary', models.summarizer.primary],
    ['models.summarizer.fallback', models.summarizer.fallback],
    ['models.safetyGate', models.safetyGate],
    ...models.extraGrants.map((m, i): [string, string] => [`models.extraGrants[${i}]`, m]),
  ];

  for (const [at, id] of all) {
    const group = inferenceProfileGroup(id);
    if (group === undefined) continue;
    if (group === 'global') {
      // A global profile can send prompts to any commercial region, which
      // profileRegions cannot bound.
      r.fail(at, `uses a global inference profile (${id}); use a geographic profile such as us.* instead`);
      continue;
    }
    const geography = PROFILE_GEOGRAPHIES[group]!;
    // A geographic profile is only callable from, and only routes to,
    // regions in its own geography.
    if (REGION.test(region) && !geography.covers(region)) {
      r.fail(at, `is a ${group}.* inference profile, which needs aws.region to be ${geography.regions} (got ${region})`);
    }
    if (models.profileRegions.length === 0) r.fail('models.profileRegions', `must list the regions ${id} routes to`);
    for (const pr of models.profileRegions) {
      if (REGION.test(pr) && !geography.covers(pr)) {
        r.fail('models.profileRegions', `contains ${pr}, which ${group}.* profile ${id} cannot route to`);
      }
    }
  }

  if (models.safetyGate.startsWith('openai.')) {
    r.fail('models.safetyGate', 'must be a Bedrock model; the webhook calls it through the Converse API');
  }
  const mantleModels = all.filter(([, id]) => id.startsWith('openai.'));
  if (mantleModels.length > 0) {
    if (!models.mantleRegion) {
      r.fail('models.mantleRegion', `is required because ${mantleModels.map(([at]) => at).join(', ')} use Mantle (openai.*)`);
    } else if (!models.mantleGrantRegions.includes(models.mantleRegion)) {
      r.fail('models.mantleGrantRegions', `must include models.mantleRegion (${models.mantleRegion})`);
    }
  }
  return models;
}

/**
 * Agent limits. The curator rejects values outside these ranges at boot
 * (agents/curator/src/config.ts), so synthesis rejects them first. The
 * reviewers use the same ranges.
 */
const MAX_ITERATIONS = { min: 1, max: 500, integer: true } as const;
const MAX_TOKENS = { min: 1024, max: 200_000, integer: true } as const;
/** At least 2, so one comment never becomes a reviewer skill on its own. */
const GRADUATION_THRESHOLD = { min: 2, max: 100, integer: true } as const;

function parseAgents(r: Reader, value: unknown): AgentsConfig {
  const o = r.object(value, 'agents', [...REVIEWER_IDS, 'curator']);
  const reviewer = (id: ReviewerId): ReviewerAgentConfig => {
    const a = r.object(o[id], `agents.${id}`, ['maxIterations', 'maxTokens', 'allowBuild', 'allowWrite']);
    return {
      maxIterations: r.number(a.maxIterations, `agents.${id}.maxIterations`, { fallback: 150, ...MAX_ITERATIONS }),
      maxTokens: r.number(a.maxTokens, `agents.${id}.maxTokens`, { fallback: 32_768, ...MAX_TOKENS }),
      allowBuild: r.boolean(a.allowBuild, `agents.${id}.allowBuild`, true),
      allowWrite: r.boolean(a.allowWrite, `agents.${id}.allowWrite`, true),
    };
  };
  const c = r.object(o.curator, 'agents.curator', ['maxIterations', 'maxTokens', 'graduationThreshold']);
  return {
    'valkey-review': reviewer('valkey-review'),
    'valkey-glide-review': reviewer('valkey-glide-review'),
    curator: {
      maxIterations: r.number(c.maxIterations, 'agents.curator.maxIterations', { fallback: 40, ...MAX_ITERATIONS }),
      maxTokens: r.number(c.maxTokens, 'agents.curator.maxTokens', { fallback: 16_384, ...MAX_TOKENS }),
      graduationThreshold: r.number(c.graduationThreshold, 'agents.curator.graduationThreshold', { fallback: 4, ...GRADUATION_THRESHOLD }),
    },
  };
}

/** Default location of the real configuration file. */
export const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'deploy.config.json');

/**
 * Picks the configuration file: `-c config=PATH` first, then the
 * VALKEY_REVIEWER_CONFIG environment variable, then infra/deploy.config.json.
 * Relative paths resolve against the current directory.
 */
export function resolveConfigPath(contextValue: unknown, env: NodeJS.ProcessEnv): string {
  const fromContext = typeof contextValue === 'string' ? contextValue.trim() : '';
  const fromEnv = env.VALKEY_REVIEWER_CONFIG?.trim() ?? '';
  const chosen = fromContext || fromEnv;
  return chosen ? path.resolve(chosen) : DEFAULT_CONFIG_PATH;
}

export function loadDeploymentConfig(contextValue: unknown, env: NodeJS.ProcessEnv): DeploymentConfig {
  const file = resolveConfigPath(contextValue, env);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Cannot read deployment configuration ${file}. Copy infra/deploy.config.example.json to ` +
      'infra/deploy.config.json and fill it in, or pass -c config=PATH.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseDeploymentConfig(raw, env);
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Empty string or unset: the route does not project a ready-for-human-review label. */
function readyLabelOf(r: Reader, value: unknown, at: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    r.fail(at, 'must be a string');
    return undefined;
  }
  if (/[\r\n]/.test(value) || value.trim() === '' || value.length > 50) {
    r.fail(at, 'must be 1 to 50 characters with no CR/LF and not whitespace-only');
    return undefined;
  }
  return value;
}

/** Repositories one reviewer's token broker may issue tokens for: that reviewer's review routes. */
export function tokenBrokerRepos(config: DeploymentConfig, reviewerId: ReviewerId): string[] {
  return [...new Set(config.routes.filter((route) => route.reviewer === reviewerId).map((route) => route.repo))];
}

/** Repositories that project readiness onto a GitHub label, mapped to that label. */
export function readyLabelsByRepo(config: DeploymentConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const route of config.routes) {
    if (route.readyLabel) out[route.repo] = route.readyLabel;
  }
  return out;
}

/**
 * UPSTREAM_REPOS_JSON for the decay job and the curator: the reviewers
 * that have an upstream, so a reviewer set to "" gets no release checks.
 */
export function upstreamReposJson(upstreamRepos: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(upstreamRepos).filter(([, repo]) => repo !== '')));
}
