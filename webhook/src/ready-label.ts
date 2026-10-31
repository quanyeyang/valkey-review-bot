import { botMatcher, isAppLogin, type GitHubUser } from './config.js';
import { fetchRepoInstallation, type GitHubApi } from './github.js';

/**
 * Projects this App's review readiness onto one PR label. Callers send
 * only `{ installation_id, repo, pr_number }`. The label name comes from
 * the environment, never from the event. The token minted here is
 * `pull_requests: write` and `metadata: read`. That adds or removes a
 * label that already exists on the pull request. It cannot create one:
 * GitHub answers 403, which is logged as `missing-label`.
 *
 * The label is added when the PR is open and not a draft and this App has
 * a completed review at the current head. On ready, every thread this App
 * started is resolved or has a later human reply that does not @mention
 * the bot. On needs_work that is not enough: at least one such thread
 * must have been addressed, or a blocking PR-wide finding or Direction
 * must have a later human issue comment that does not @mention the bot.
 * Minors do not count. An empty needs_work does not get the label.
 * Missing, failed, or stale reviews never count. Anything else removes
 * the label if it is present.
 *
 * Before a mutation the head is fetched again. After one, the head,
 * comments and threads are fetched again: a resolve that races an
 * unresolve (or a reply that races a deletion) must not leave the
 * label on. ReadyLabelFn runs with reserved concurrency 1 so async
 * invokes for every PR are serialized; a throttled Event is retried.
 * If attempts run out after an add, or a later read throws, the label
 * is removed before the invocation ends. A new attempt does not start
 * when the Lambda has under ten seconds left.
 */

/** Identical to agents/common/src/review-state.ts. Tests parse that renderer. */
export const STATE_MARKER = '<!-- valkey-reviewer:state -->';

export const LABEL_PERMISSIONS = { pull_requests: 'write', metadata: 'read' } as const;

/** Stop before a new attempt when the Lambda has less than this left. */
export const MIN_REMAINING_MS = 10_000;

/** Restarts when the head or the predicate moves under a reconcile. */
export const MAX_RECONCILE_ATTEMPTS = 4;

export interface LabelTokenRequest {
  readonly installationId: number;
  readonly repositoryNames: string[];
  readonly permissions: typeof LABEL_PERMISSIONS;
}

export interface ReadyLabelEvent {
  readonly installation_id?: unknown;
  readonly repo?: unknown;
  readonly pr_number?: unknown;
}

export type ReadyLabelResult = { ok: true; decision: string } | { error: string };

export interface ReadyState {
  readonly ready: boolean;
  readonly headPrefix: string;
}

export interface ReviewThread {
  readonly isResolved: boolean;
  readonly comments: readonly { readonly author?: GitHubUser; readonly body?: string }[];
}

export interface ReconcileDeps {
  readonly api: GitHubApi;
  readonly graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
  readonly repo: string;
  readonly prNumber: number;
  readonly appId: number;
  readonly botLogin: string;
  readonly isBot: (user: GitHubUser | undefined) => boolean;
  readonly label: string;
  /** Milliseconds until the Lambda invocation is frozen. Absent in tests. */
  readonly remainingMs?: () => number;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

export interface ReadyLabelDeps {
  readonly allowedRepos: readonly string[];
  readonly labelsByRepo: Readonly<Record<string, string>>;
  readonly appId: number;
  readonly botLogin: string;
  readonly knownBotLogins: ReadonlySet<string>;
  readonly remainingMs?: () => number;
  readonly appApi: () => Promise<GitHubApi>;
  readonly issueToken: (request: LabelTokenRequest) => Promise<{ token: string; expiresAt: string }>;
  readonly githubApi: (token: string) => GitHubApi;
  readonly graphql: (token: string, query: string, variables: Record<string, unknown>) => Promise<unknown>;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) {
            nodes {
              author { __typename login }
              body
            }
          }
        }
      }
    }
  }
}`;

interface IssueComment {
  readonly body?: string | null;
  readonly user?: GitHubUser;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly performed_via_github_app?: { readonly id?: unknown } | null;
}

interface PullSnapshot {
  readonly state: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly labels: readonly string[];
}

/**
 * Reads the sticky state comment this App writes. Undefined when the body
 * is not ours or does not carry both the ready line and the head stamp.
 */
export function parseReadyState(body: string): ReadyState | undefined {
  if (!body.startsWith(STATE_MARKER)) return undefined;
  const ready = /^\*\*Ready for human review\.\*\*\s*$/m.test(body);
  const notReady = /^\*\*Not ready for human review yet\.\*\*\s*$/m.test(body);
  if (ready === notReady) return undefined;
  const stamp = /Updated for ([0-9a-fA-F]{10}) at/.exec(body);
  if (!stamp) return undefined;
  return { ready, headPrefix: stamp[1]!.toLowerCase() };
}

/**
 * True when the rendered state still has a PR-wide concern a human must
 * answer: an open finding with no `path:line`, or a Direction section.
 * Inline findings are the review threads. Matches renderReviewState.
 */
export function openPrWideConcerns(body: string): boolean {
  if (!body.startsWith(STATE_MARKER)) return false;
  if (/\*\*Direction\*\*/.test(body)) return true;
  const heading = /\*\*Open findings(?::\*\* none\.| \((\d+)\)\*\*)/.exec(body);
  if (!heading || heading[0].includes('none')) return false;
  const rest = body.slice(body.indexOf(heading[0]) + heading[0].length);
  const section = rest.split(/\n\*\*/)[0] ?? '';
  for (const line of section.split('\n')) {
    if (!line.startsWith('- ')) continue;
    if (line.startsWith('- (minor) ')) continue;
    if (/^- `/.test(line)) continue;
    return true;
  }
  return false;
}

/**
 * Same boundary as mentionPattern in mention.ts. People type @slug, not
 * @slug[bot]. A tag is a command to the bot, not an answer to a finding.
 */
export function mentionsBot(body: string | undefined, botLogin: string): boolean {
  if (!body) return false;
  const handle = botLogin.replace(/\[bot\]$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@/-])@${handle}(?![\\w-])`, 'i').test(body);
}

/**
 * GraphQL Actor.login for a Bot is the slug. REST user.login is
 * slug[bot]. __typename Bot is what makes it a bot; the suffix is not
 * in the GraphQL string. A User with the same slug is not this App.
 */
export function isAppGraphQLAuthor(author: GitHubUser | undefined, botLogin: string): boolean {
  if (!author?.login || author.type !== 'Bot') return false;
  const slug = (login: string) => login.toLowerCase().replace(/\[bot\]$/, '');
  return slug(author.login) === slug(botLogin);
}

/**
 * A non-bot issue comment created after the state comment was last
 * rewritten. Used for PR-wide findings, which have no review thread.
 */
export function humanAnsweredAfter(
  comments: readonly IssueComment[],
  stateComment: IssueComment,
  isBot: (user: GitHubUser | undefined) => boolean,
  botLogin: string,
): boolean {
  const after = stateComment.updated_at ?? stateComment.created_at;
  if (typeof after !== 'string' || !after) return false;
  for (const comment of comments) {
    if (comment === stateComment) continue;
    if (!comment.user?.login || isBot(comment.user)) continue;
    if (mentionsBot(comment.body ?? undefined, botLogin)) continue;
    const at = comment.created_at;
    if (typeof at === 'string' && at > after) return true;
  }
  return false;
}

/**
 * True when the PR should carry the configured ready label. A completed
 * review at this head is required. On ready, addressed threads are
 * enough and a blocking PR-wide finding still blocks. On needs_work,
 * an empty comment does not qualify: this App must have started a
 * thread that was addressed, or a blocking PR-wide finding or Direction
 * must have a later human issue comment.
 */
export function wantReadyLabel(args: {
  readonly prState: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly state: ReadyState | undefined;
  readonly threadsOk: boolean;
  readonly hasAppThread: boolean;
  readonly blockingPrWide: boolean;
  readonly prWideAnswered: boolean;
}): boolean {
  if (args.prState !== 'open' || args.draft) return false;
  if (!args.state) return false;
  if (args.state.headPrefix !== args.headSha.slice(0, 10).toLowerCase()) return false;
  if (!args.threadsOk) return false;
  if (args.state.ready) return !args.blockingPrWide;
  if (args.blockingPrWide) return args.prWideAnswered;
  return args.hasAppThread;
}

/**
 * Every thread this App started is either resolved or has a later comment
 * whose author is not a bot and which does not @mention the bot. Threads
 * someone else started are ignored. The first comment's author is the
 * GraphQL shape: bare login, type Bot.
 */
export function threadsAddressed(
  threads: readonly ReviewThread[],
  botLogin: string,
  isBot: (user: GitHubUser | undefined) => boolean,
): boolean {
  for (const thread of threads) {
    if (!isAppGraphQLAuthor(thread.comments[0]?.author, botLogin)) continue;
    if (thread.isResolved) continue;
    const humanReply = thread.comments.slice(1).some((c) =>
      c.author !== undefined && !isBot(c.author) && !mentionsBot(c.body, botLogin));
    if (!humanReply) return false;
  }
  return true;
}

export function hasAppThread(threads: readonly ReviewThread[], botLogin: string): boolean {
  return threads.some((thread) => isAppGraphQLAuthor(thread.comments[0]?.author, botLogin));
}

function sameHead(a: PullSnapshot, b: PullSnapshot): boolean {
  return a.headSha === b.headSha && a.state === b.state && a.draft === b.draft;
}

function hasLabel(pull: PullSnapshot, label: string): boolean {
  return pull.labels.some((name) => name.toLowerCase() === label.toLowerCase());
}

async function readWant(
  deps: ReconcileDeps,
  pull: PullSnapshot,
): Promise<boolean> {
  const comments = await listIssueComments(deps.api, deps.repo, deps.prNumber);
  const stateComment = findAppStateComment(comments, deps.botLogin, deps.appId);
  const body = stateComment?.body ?? '';
  const state = stateComment ? parseReadyState(body) : undefined;
  const threads = await listReviewThreads(deps.graphql, deps.repo, deps.prNumber);
  const blockingPrWide = !!stateComment && openPrWideConcerns(body);
  return wantReadyLabel({
    prState: pull.state,
    draft: pull.draft,
    headSha: pull.headSha,
    state,
    threadsOk: threadsAddressed(threads, deps.botLogin, deps.isBot),
    hasAppThread: hasAppThread(threads, deps.botLogin),
    blockingPrWide,
    prWideAnswered: !!stateComment && humanAnsweredAfter(comments, stateComment, deps.isBot, deps.botLogin),
  });
}

export async function reconcileReadyLabel(deps: ReconcileDeps): Promise<string> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const { repo, prNumber, label } = deps;
  const remainingMs = deps.remainingMs ?? (() => Number.POSITIVE_INFINITY);
  let leftoverAdd = false;

  try {
    for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt++) {
      if (remainingMs() < MIN_REMAINING_MS) {
        log(`[ready-label] repo=${repo} pr=${prNumber} stopping with ${remainingMs()}ms left`);
        break;
      }
      const pull = await fetchPull(deps.api, repo, prNumber);
      const want = await readWant(deps, pull);

      const latest = await fetchPull(deps.api, repo, prNumber);
      if (!sameHead(pull, latest)) {
        log(`[ready-label] repo=${repo} pr=${prNumber} stale-head attempt=${attempt}`);
        continue;
      }

      const has = hasLabel(latest, label);
      let decision: string;
      let mutated = false;
      if (want && has) {
        decision = 'already-on';
      } else if (want && !has) {
        decision = await addLabel(deps.api, repo, prNumber, label);
        mutated = decision === 'added' || decision === 'missing-label';
        leftoverAdd = decision === 'added';
      } else if (!want && has) {
        await removeLabel(deps.api, repo, prNumber, label);
        leftoverAdd = false;
        decision = 'removed';
        mutated = true;
      } else {
        decision = 'already-off';
      }

      if (mutated) {
        const after = await fetchPull(deps.api, repo, prNumber);
        if (!sameHead(pull, after) || await readWant(deps, after) !== want) {
          log(`[ready-label] repo=${repo} pr=${prNumber} stale after ${decision} attempt=${attempt}`);
          continue;
        }
      }

      if (decision === 'missing-label') {
        warn(`[ready-label] repo=${repo} pr=${prNumber} missing-label=${JSON.stringify(label)}`);
      } else {
        log(`[ready-label] repo=${repo} pr=${prNumber} want=${want} decision=${decision}`);
      }
      return decision;
    }
  } catch (err) {
    if (leftoverAdd) {
      try {
        await removeLabel(deps.api, repo, prNumber, label);
      } catch (undo) {
        warn(`[ready-label] repo=${repo} pr=${prNumber} undo failed: ${undo instanceof Error ? undo.message : String(undo)}`);
      }
    }
    throw err;
  }

  if (leftoverAdd) await removeLabel(deps.api, repo, prNumber, label);
  warn(`[ready-label] repo=${repo} pr=${prNumber} stale-head after ${MAX_RECONCILE_ATTEMPTS} attempts`);
  return 'stale-head';
}

/**
 * Logs an operational failure and rethrows so an async Lambda invoke
 * retries it. Validation refusals (`{ error }`) resolve as success and
 * must not be thrown.
 */
export async function runReadyLabelHandler(
  apply: (event: ReadyLabelEvent) => Promise<ReadyLabelResult>,
  event: ReadyLabelEvent,
): Promise<ReadyLabelResult> {
  try {
    return await apply(event);
  } catch (err) {
    console.error('[ready-label] failed', err);
    throw err;
  }
}

export function createReadyLabelApplier(deps: ReadyLabelDeps): (event: ReadyLabelEvent) => Promise<ReadyLabelResult> {
  const allowed: ReadonlySet<string> = new Set(deps.allowedRepos.map((r) => r.toLowerCase()));
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const isBot = botMatcher(deps.botLogin, deps.knownBotLogins);

  return async (event) => {
    const installationId = Number(event.installation_id);
    const repo = typeof event.repo === 'string' ? event.repo : '';
    const prNumber = Number(event.pr_number);
    const [owner, name, extra] = repo.split('/');
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return { error: 'invalid installation_id' };
    if (!owner || !name || extra !== undefined) return { error: 'repo must be "owner/name"' };
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return { error: 'invalid pr_number' };
    if (!allowed.has(repo.toLowerCase())) {
      warn(`[ready-label] refused repo=${repo}`);
      return { error: `repo ${repo} is not a routed repository` };
    }
    const label = labelForRepo(deps.labelsByRepo, repo);
    if (!label) {
      warn(`[ready-label] refused repo=${repo}: no label configured`);
      return { error: `repo ${repo} is not configured for a ready label` };
    }

    const installation = await fetchRepoInstallation(await deps.appApi(), repo);
    if (!installation) {
      warn(`[ready-label] refused repo=${repo}: the App is not installed there`);
      return { error: `the App is not installed on ${repo}` };
    }
    if (installation.id !== installationId || installation.account.toLowerCase() !== owner.toLowerCase()) {
      warn(`[ready-label] refused repo=${repo} installation=${installationId}: the App's installation is ${installation.id} on ${installation.account}`);
      return { error: `installation ${installationId} is not the App's installation on ${repo}` };
    }

    const { token } = await deps.issueToken({
      installationId,
      repositoryNames: [name],
      permissions: LABEL_PERMISSIONS,
    });
    const decision = await reconcileReadyLabel({
      api: deps.githubApi(token),
      graphql: (query, variables) => deps.graphql(token, query, variables),
      repo,
      prNumber,
      appId: deps.appId,
      botLogin: deps.botLogin,
      isBot,
      label,
      remainingMs: deps.remainingMs,
      log,
      warn,
    });
    return { ok: true, decision };
  };
}

function labelForRepo(labelsByRepo: Readonly<Record<string, string>>, repo: string): string | undefined {
  const want = repo.toLowerCase();
  for (const [key, value] of Object.entries(labelsByRepo)) {
    if (key.toLowerCase() === want && value) return value;
  }
  return undefined;
}

function findAppStateComment(comments: readonly IssueComment[], botLogin: string, appId: number): IssueComment | undefined {
  let found: IssueComment | undefined;
  for (const comment of comments) {
    if (!isAppLogin(comment.user?.login, botLogin)) continue;
    if (typeof comment.body !== 'string' || !comment.body.startsWith(STATE_MARKER)) continue;
    const via = comment.performed_via_github_app;
    if (via && typeof via.id === 'number' && via.id !== appId) continue;
    found = comment;
  }
  return found;
}

async function fetchPull(api: GitHubApi, repo: string, prNumber: number): Promise<PullSnapshot> {
  const { status, json } = await api('GET', `repos/${repo}/pulls/${prNumber}`);
  if (status !== 200) throw new Error(`GET repos/${repo}/pulls/${prNumber} returned ${status}`);
  const pr = json as {
    state?: unknown;
    draft?: unknown;
    head?: { sha?: unknown };
    labels?: unknown;
  };
  if (typeof pr.state !== 'string' || typeof pr.head?.sha !== 'string') {
    throw new Error(`GET repos/${repo}/pulls/${prNumber} returned no state or head sha`);
  }
  const labels = Array.isArray(pr.labels)
    ? pr.labels.flatMap((item) => (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string'
      ? [(item as { name: string }).name]
      : []))
    : [];
  return {
    state: pr.state,
    draft: pr.draft === true,
    headSha: pr.head.sha,
    labels,
  };
}

async function listIssueComments(api: GitHubApi, repo: string, prNumber: number): Promise<IssueComment[]> {
  const out: IssueComment[] = [];
  for (let page = 1; page <= 30; page++) {
    const { status, json } = await api('GET', `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (status !== 200) throw new Error(`GET repos/${repo}/issues/${prNumber}/comments returned ${status}`);
    if (!Array.isArray(json)) throw new Error(`GET repos/${repo}/issues/${prNumber}/comments returned no list`);
    out.push(...(json as IssueComment[]));
    if (json.length < 100) break;
  }
  return out;
}

async function listReviewThreads(
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const [owner, name] = repo.split('/') as [string, string];
  const threads: ReviewThread[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const data = await graphql(THREADS_QUERY, {
      owner,
      name,
      number: prNumber,
      ...(cursor ? { cursor } : {}),
    }) as {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            nodes?: unknown;
          };
        } | null;
      };
    };
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    if (Array.isArray(connection.nodes)) {
      for (const node of connection.nodes) {
        const parsed = parseThread(node);
        if (parsed) threads.push(parsed);
      }
    }
    if (connection.pageInfo?.hasNextPage !== true || typeof connection.pageInfo.endCursor !== 'string') break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

function parseThread(node: unknown): ReviewThread | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const t = node as { isResolved?: unknown; comments?: { nodes?: unknown } };
  const nodes = t.comments?.nodes;
  const comments = Array.isArray(nodes) ? nodes.map(parseThreadComment) : [];
  return { isResolved: t.isResolved === true, comments };
}

function parseThreadComment(node: unknown): { author?: GitHubUser; body?: string } {
  if (typeof node !== 'object' || node === null) return {};
  const raw = node as { author?: { __typename?: unknown; login?: unknown } | null; body?: unknown };
  const body = typeof raw.body === 'string' ? raw.body : undefined;
  const author = raw.author;
  if (!author || typeof author.login !== 'string') return { body };
  return {
    body,
    author: {
      login: author.login,
      type: author.__typename === 'Bot' ? 'Bot' : 'User',
    },
  };
}

async function addLabel(api: GitHubApi, repo: string, prNumber: number, label: string): Promise<string> {
  const { status, json } = await api('POST', `repos/${repo}/issues/${prNumber}/labels`, { labels: [label] });
  if (status === 404 || status === 422 || refusesToCreateLabel(status, json)) return 'missing-label';
  if (status !== 200) throw new Error(`POST repos/${repo}/issues/${prNumber}/labels returned ${status}`);
  return 'added';
}

function refusesToCreateLabel(status: number, json: unknown): boolean {
  if (status !== 403) return false;
  const message = typeof json === 'object' && json !== null && typeof (json as { message?: unknown }).message === 'string'
    ? (json as { message: string }).message
    : '';
  return /create labels/i.test(message);
}

async function removeLabel(api: GitHubApi, repo: string, prNumber: number, label: string): Promise<void> {
  const path = `repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`;
  const { status } = await api('DELETE', path);
  // 404: the label is already off the issue.
  if (status !== 200 && status !== 204 && status !== 404) {
    throw new Error(`DELETE ${path} returned ${status}`);
  }
}
