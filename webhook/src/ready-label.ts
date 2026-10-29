import { botMatcher, isAppLogin, type GitHubUser } from './config.js';
import { fetchRepoInstallation, type GitHubApi } from './github.js';

/**
 * Projects this App's review readiness onto one PR label. The reviewer
 * runtime never sees `issues: write`: this module mints that token itself
 * and mutates GitHub. Callers send only `{ installation_id, repo, pr_number }`.
 * The label name comes from the environment, never from the event.
 *
 * The label is added only when the PR is open and not a draft, this App's
 * sticky state comment says ready at the current head, and every review
 * thread this App started is resolved or has a later human reply. Anything
 * else removes the label if it is present. The label is never created.
 */

/** Identical to agents/common/src/review-state.ts. Tests parse that renderer. */
export const STATE_MARKER = '<!-- valkey-reviewer:state -->';

export const LABEL_PERMISSIONS = { issues: 'write', pull_requests: 'read', metadata: 'read' } as const;

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
  readonly comments: readonly { readonly author?: GitHubUser }[];
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
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

export interface ReadyLabelDeps {
  readonly allowedRepos: readonly string[];
  readonly labelsByRepo: Readonly<Record<string, string>>;
  readonly appId: number;
  readonly botLogin: string;
  readonly knownBotLogins: ReadonlySet<string>;
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
  readonly performed_via_github_app?: { readonly id?: unknown } | null;
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

/** True when the PR should carry the configured ready label. */
export function wantReadyLabel(args: {
  readonly prState: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly state: ReadyState | undefined;
  readonly threadsOk: boolean;
}): boolean {
  if (args.prState !== 'open' || args.draft) return false;
  if (!args.state?.ready) return false;
  if (args.state.headPrefix !== args.headSha.slice(0, 10).toLowerCase()) return false;
  return args.threadsOk;
}

/**
 * Every thread this App started is either resolved or has a later comment
 * whose author is not a bot. Threads someone else started are ignored.
 * Resolve without a reply counts; a human reply without resolve counts.
 */
export function threadsAddressed(
  threads: readonly ReviewThread[],
  botLogin: string,
  isBot: (user: GitHubUser | undefined) => boolean,
): boolean {
  for (const thread of threads) {
    const first = thread.comments[0]?.author;
    if (!isAppLogin(first?.login, botLogin)) continue;
    if (thread.isResolved) continue;
    const humanReply = thread.comments.slice(1).some((c) => c.author !== undefined && !isBot(c.author));
    if (!humanReply) return false;
  }
  return true;
}

export async function reconcileReadyLabel(deps: ReconcileDeps): Promise<string> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const { repo, prNumber, label } = deps;

  const pull = await fetchPull(deps.api, repo, prNumber);
  const comments = await listIssueComments(deps.api, repo, prNumber);
  const stateComment = findAppStateComment(comments, deps.botLogin, deps.appId);
  const state = stateComment ? parseReadyState(stateComment.body ?? '') : undefined;
  const threads = await listReviewThreads(deps.graphql, repo, prNumber);
  const threadsOk = threadsAddressed(threads, deps.botLogin, deps.isBot);
  const want = wantReadyLabel({
    prState: pull.state,
    draft: pull.draft,
    headSha: pull.headSha,
    state,
    threadsOk,
  });
  const has = pull.labels.some((name) => name.toLowerCase() === label.toLowerCase());

  let decision: string;
  if (want && has) {
    decision = 'already-on';
  } else if (want && !has) {
    const added = await addLabel(deps.api, repo, prNumber, label);
    decision = added;
  } else if (!want && has) {
    await removeLabel(deps.api, repo, prNumber, label);
    decision = 'removed';
  } else {
    decision = 'already-off';
  }

  if (decision === 'missing-label') {
    warn(`[ready-label] repo=${repo} pr=${prNumber} missing-label=${JSON.stringify(label)}`);
  } else {
    log(`[ready-label] repo=${repo} pr=${prNumber} want=${want} decision=${decision}`);
  }
  return decision;
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

async function fetchPull(api: GitHubApi, repo: string, prNumber: number): Promise<{
  state: string;
  draft: boolean;
  headSha: string;
  labels: readonly string[];
}> {
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

function parseThreadComment(node: unknown): { author?: GitHubUser } {
  if (typeof node !== 'object' || node === null) return {};
  const author = (node as { author?: { __typename?: unknown; login?: unknown } | null }).author;
  if (!author || typeof author.login !== 'string') return {};
  return {
    author: {
      login: author.login,
      type: author.__typename === 'Bot' ? 'Bot' : 'User',
    },
  };
}

async function addLabel(api: GitHubApi, repo: string, prNumber: number, label: string): Promise<string> {
  const { status } = await api('POST', `repos/${repo}/issues/${prNumber}/labels`, { labels: [label] });
  if (status === 404 || status === 422) return 'missing-label';
  if (status !== 200) throw new Error(`POST repos/${repo}/issues/${prNumber}/labels returned ${status}`);
  return 'added';
}

async function removeLabel(api: GitHubApi, repo: string, prNumber: number, label: string): Promise<void> {
  const path = `repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`;
  const { status } = await api('DELETE', path);
  // 404: the label is already off the issue.
  if (status !== 200 && status !== 204 && status !== 404) {
    throw new Error(`DELETE ${path} returned ${status}`);
  }
}
