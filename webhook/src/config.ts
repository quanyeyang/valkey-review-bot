/**
 * Environment settings for the receiver and the invoker. Each loader runs
 * when its function starts and throws an error that names the bad
 * setting, so a misconfigured function fails at once instead of
 * misbehaving later. infra/lib/webhook-stack.ts sets these variables;
 * webhook/README.md lists them.
 */

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Logins of other review and automation bots, whose comments are never
 * maintainer feedback. The user type and the [bot] suffix already catch
 * most bots; the list also names logins without the suffix. Matched
 * case-insensitively. A non-empty KNOWN_BOT_LOGINS replaces this list.
 */
export const DEFAULT_KNOWN_BOT_LOGINS: readonly string[] = [
  'coderabbitai',
  'coderabbitai[bot]',
  'copilot',
  'copilot[bot]',
  'github-actions[bot]',
  'dependabot[bot]',
  'codecov[bot]',
  'sonarcloud[bot]',
  'deepsource-io-bot',
  'sourcery-ai[bot]',
];

export const DEFAULT_DAILY_REVIEW_BUDGET = 40;
export const DEFAULT_MAX_AUTOMATIC_REVIEWS_PER_PR = 3;
export const DEFAULT_PUSH_REVIEW_DELAY_SECONDS = 300;
export const DEFAULT_RUN_BUDGET_MINUTES = 90;
export const DEFAULT_HEARTBEAT_STALE_MINUTES = 12;

/** One review route, keyed in REVIEW_ROUTE_MAP_JSON by repository full name. */
export interface ReviewRoute {
  /** The route id from the deployment configuration. Names the route's daily review counter. */
  readonly routeId: string;
  readonly queueUrl: string;
  readonly reviewerId: string;
  /** Lowercased PR author logins. Empty means any author. */
  readonly authorAllowlist: readonly string[];
  /** Pull request events never start a review; only @mentions do. */
  readonly mentionOnly: boolean;
  /** Draft PRs wait for ready_for_review instead of reviewing on open. */
  readonly skipDrafts: boolean;
  /**
   * An @mention reply in a review thread starts a run. In a thread the App
   * started, the run answers the reply (a fix claim, a dispute or a
   * question); in any other thread the reply is an ordinary summons.
   */
  readonly threadReplyReview: boolean;
  /**
   * GitHub label this route projects readiness onto. Absent when the
   * route does not use a ready-for-human-review label.
   */
  readonly readyLabel?: string;
}

export interface CuratorRoute {
  readonly reviewerId: string;
}

export interface ReceiverConfig {
  /** Keyed by lowercased repository full name. Only these repositories can start a review. */
  readonly reviewRoutes: ReadonlyMap<string, ReviewRoute>;
  /** Keyed by lowercased repository full name. Repositories whose feedback reaches the curator. */
  readonly curatorRoutes: ReadonlyMap<string, CuratorRoute>;
  readonly idempotencyTable: string;
  readonly githubSecretArn: string;
  /** Empty when feedback is not forwarded to a curator. */
  readonly curatorQueueUrl: string;
  /** The App's bot login, for example "your-app-slug[bot]". */
  readonly botLogin: string;
  /** Lowercased. */
  readonly knownBotLogins: ReadonlySet<string>;
  /** Used only when a delivery carries no installation id. */
  readonly installationId?: number;
  /** Bedrock model that screens @mention instructions. */
  readonly safetyModelId: string;
  /** Automatic reviews per route per UTC day. 0 pauses automatic reviews. */
  readonly dailyReviewBudget: number;
  /** Automatic reviews one pull request can get, the first one included. @mentions do not count. */
  readonly maxAutomaticReviewsPerPr: number;
  /** How long a review of new commits waits in the queue, so a burst of pushes gets one review. */
  readonly pushReviewDelaySeconds: number;
}

export interface InvokerConfig {
  readonly runtimeArn: string;
  /** Required for review messages; the curator queue's worker does not get one. */
  readonly heartbeatTable: string;
  /** Wall-clock budget for one review across all attempts and models. */
  readonly runBudgetMs: number;
  /** A running review whose heartbeat is older than this is treated as dead. */
  readonly staleMs: number;
  /**
   * The receiver's table, where an automatic review holds its pull
   * request's pending marker until the worker starts the run. Empty on
   * the curator's worker. A review worker without it leaves markers to
   * expire, and automatic reviews of that pull request are skipped until
   * then. It still tells a review that never ran from a run that died,
   * by the run's start record (src/watchdog.ts).
   */
  readonly idempotencyTable: string;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max?: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || (max !== undefined && value > max) || !Number.isSafeInteger(value)) {
    const range = max === undefined ? `>= ${min}` : `from ${min} to ${max}`;
    throw new Error(`${name} must be an integer ${range} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function jsonObject(env: Env, name: string, fallback?: string): Record<string, unknown> {
  const raw = env[name]?.trim() || fallback;
  if (raw === undefined) throw new Error(`${name} is not set`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object keyed by repository`);
  }
  return parsed as Record<string, unknown>;
}

function routeString(entry: Record<string, unknown>, key: string, at: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || !value) throw new Error(`${at}.${key} must be a non-empty string`);
  return value;
}

function routeFlag(entry: Record<string, unknown>, key: string, at: string): boolean {
  const value = entry[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${at}.${key} must be true or false`);
  return value;
}

function routeOptionalString(entry: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = entry[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${at}.${key} must be a non-empty string`);
  return value;
}

function routeEntry(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function parseReviewRoutes(raw: Record<string, unknown>): Map<string, ReviewRoute> {
  const routes = new Map<string, ReviewRoute>();
  for (const [repo, value] of Object.entries(raw)) {
    const at = `REVIEW_ROUTE_MAP_JSON[${JSON.stringify(repo)}]`;
    const entry = routeEntry(value, at);
    const allowlist = entry.authorAllowlist ?? [];
    if (!Array.isArray(allowlist) || !allowlist.every((a) => typeof a === 'string')) {
      throw new Error(`${at}.authorAllowlist must be an array of logins`);
    }
    const readyLabel = routeOptionalString(entry, 'readyLabel', at);
    routes.set(repo.toLowerCase(), {
      routeId: routeString(entry, 'routeId', at),
      queueUrl: routeString(entry, 'queueUrl', at),
      reviewerId: routeString(entry, 'reviewerId', at),
      authorAllowlist: allowlist.map((a: string) => a.toLowerCase()),
      mentionOnly: routeFlag(entry, 'mentionOnly', at),
      skipDrafts: routeFlag(entry, 'skipDrafts', at),
      threadReplyReview: routeFlag(entry, 'threadReplyReview', at),
      ...(readyLabel ? { readyLabel } : {}),
    });
  }
  return routes;
}

function parseCuratorRoutes(raw: Record<string, unknown>): Map<string, CuratorRoute> {
  const routes = new Map<string, CuratorRoute>();
  for (const [repo, value] of Object.entries(raw)) {
    const at = `CURATOR_ROUTE_MAP_JSON[${JSON.stringify(repo)}]`;
    routes.set(repo.toLowerCase(), { reviewerId: routeString(routeEntry(value, at), 'reviewerId', at) });
  }
  return routes;
}

/** Comma-separated logins. Unset or empty means the built-in list. */
export function parseKnownBotLogins(raw: string | undefined): Set<string> {
  const listed = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(listed.length > 0 ? listed : DEFAULT_KNOWN_BOT_LOGINS);
}

export function loadReceiverConfig(env: Env): ReceiverConfig {
  const installationId = env.INSTALLATION_ID?.trim();
  if (installationId && !/^[1-9]\d*$/.test(installationId)) {
    throw new Error(`INSTALLATION_ID must be a numeric installation id (got ${JSON.stringify(installationId)})`);
  }
  return {
    reviewRoutes: parseReviewRoutes(jsonObject(env, 'REVIEW_ROUTE_MAP_JSON')),
    curatorRoutes: parseCuratorRoutes(jsonObject(env, 'CURATOR_ROUTE_MAP_JSON', '{}')),
    idempotencyTable: required(env, 'IDEMPOTENCY_TABLE'),
    githubSecretArn: required(env, 'GITHUB_SECRET_ARN'),
    curatorQueueUrl: env.CURATOR_QUEUE_URL?.trim() ?? '',
    botLogin: required(env, 'BOT_LOGIN'),
    knownBotLogins: parseKnownBotLogins(env.KNOWN_BOT_LOGINS),
    ...(installationId ? { installationId: Number(installationId) } : {}),
    safetyModelId: required(env, 'HAIKU_MODEL_ID'),
    dailyReviewBudget: integer(env, 'DAILY_REVIEW_BUDGET', DEFAULT_DAILY_REVIEW_BUDGET, 0),
    maxAutomaticReviewsPerPr: integer(env, 'MAX_AUTOMATIC_REVIEWS_PER_PR', DEFAULT_MAX_AUTOMATIC_REVIEWS_PER_PR, 1, 20),
    // SQS takes a per-message delay of at most 900 seconds.
    pushReviewDelaySeconds: integer(env, 'PUSH_REVIEW_DELAY_SECONDS', DEFAULT_PUSH_REVIEW_DELAY_SECONDS, 0, 900),
  };
}

export function loadInvokerConfig(env: Env): InvokerConfig {
  return {
    runtimeArn: required(env, 'RUNTIME_ARN'),
    heartbeatTable: env.HEARTBEAT_TABLE?.trim() ?? '',
    runBudgetMs: integer(env, 'RUN_BUDGET_MINUTES', DEFAULT_RUN_BUDGET_MINUTES, 1) * 60_000,
    staleMs: integer(env, 'HEARTBEAT_STALE_MINUTES', DEFAULT_HEARTBEAT_STALE_MINUTES, 1) * 60_000,
    idempotencyTable: env.IDEMPOTENCY_TABLE?.trim() ?? '',
  };
}

export interface GitHubUser {
  readonly login?: string;
  readonly type?: string;
}

/**
 * Bot test used on every surface: the PR author, feedback authors, and
 * @mention authors. Any of the user type, the [bot] login suffix, this
 * App's own login, or the known-bots list marks a bot. Several signals
 * because the type field alone is one payload change away from letting
 * bot text through.
 */
export function botMatcher(botLogin: string, knownBotLogins: ReadonlySet<string>): (user: GitHubUser | undefined) => boolean {
  const own = botLogin.toLowerCase();
  return (user) => {
    if (!user) return false;
    if (user.type === 'Bot') return true;
    const login = (user.login ?? '').toLowerCase();
    return login.endsWith('[bot]') || login === own || knownBotLogins.has(login);
  };
}

/** True when `login` is this App's bot user. GitHub logins are case-insensitive. */
export function isAppLogin(login: string | undefined, botLogin: string): boolean {
  return !!login && login.toLowerCase() === botLogin.toLowerCase();
}
