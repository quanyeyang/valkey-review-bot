import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import type { StatusComment } from '../status-comment.js';
import type { TokenSource } from '../github-auth.js';
import { reviewStateSchema, renderReviewState, stripStateMarker, validateReviewState, type ReviewState, type StateCommentWriter } from '../review-state.js';
import { runBounded } from './spawn.js';

/**
 * Endpoint shapes gh_api_read may GET, after the "repos/OWNER/REPO/"
 * prefix. The agent can explore the REST surface it needs for a review
 * without reaching anything else.
 */
const GH_API_READ_PATTERNS: ReadonlyArray<RegExp> = [
  /^pulls\/\d+$/,
  /^pulls\/\d+\/files(\?.*)?$/,
  /^pulls\/\d+\/reviews(\?.*)?$/,
  /^pulls\/\d+\/reviews\/\d+$/,
  /^pulls\/\d+\/comments(\?.*)?$/,
  /^pulls\/\d+\/commits(\?.*)?$/,
  /^issues\/\d+\/comments(\?.*)?$/,
  /^commits\/[a-f0-9]+$/,
  /^contents\/.+/,
  /^check-runs\/\d+$/,
  /^commits\/[a-f0-9]+\/check-runs(\?.*)?$/,
];

/**
 * Returns why `path` may not be read, or null. The path must name one of
 * `repos` ("owner/name", compared case-insensitively) and match an
 * allowed endpoint shape. "..", percent-encoding and backslashes are
 * refused outright: each can make the URL GitHub resolves differ from
 * the path checked here.
 */
export function checkGhApiPath(path: string, repos: readonly string[]): string | null {
  if (path.includes('..')) return 'the path must not contain "..".';
  if (path.includes('%')) return 'the path must not contain percent-encoded characters.';
  if (path.includes('\\')) return 'the path must not contain backslashes.';
  if (/[\s#]/.test(path)) return 'the path must not contain whitespace or "#".';
  const m = /^repos\/([^/?]+)\/([^/?]+)\/(.*)$/.exec(path);
  if (!m) return 'the path must start with repos/OWNER/REPO/.';
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  if (!repos.some((r) => r.toLowerCase() === repo)) {
    return `only these repositories can be read: ${[...new Set(repos)].join(', ')}.`;
  }
  if (!GH_API_READ_PATTERNS.some((r) => r.test(m[3]!))) return 'the endpoint is not on the allowlist.';
  return null;
}

/**
 * GitHub rejects comment and review bodies over 65,536 characters. The
 * tools stop a little short so the links the runtime appends still fit.
 */
export const MAX_GITHUB_TEXT_CHARS = 60_000;

function tooLong(what: string, text: string): string | null {
  return text.length > MAX_GITHUB_TEXT_CHARS
    ? `${what} is ${text.length} characters; the limit is ${MAX_GITHUB_TEXT_CHARS}. Shorten it and call again.`
    : null;
}

export type TerminalToolName = 'post_review' | 'skip_review';

/**
 * Tracks the one terminal call a run may make. post_review and
 * skip_review share a gate, so after either succeeds the other returns an
 * error without touching GitHub. Tool calls from one model turn run
 * concurrently, so a second call that arrives while the first is still
 * posting is refused too.
 */
export interface TerminalGate {
  /** Claim the gate before writing to GitHub. Returns an error message when it is taken. */
  acquire(tool: TerminalToolName): string | null;
  /** Give the gate back after a call that wrote nothing, so the model can retry. */
  release(): void;
  /** Mark the run's review as done and tell the run loop. */
  complete(tool: TerminalToolName, result: string): void;
}

// Callbacks that some terminal gate will call. run-agent checks for its
// own callback after the agent's assembleTools returns, so an agent that
// does not pass onTerminal through fails before the model runs, instead
// of posting a review and then failing the run as unfinished.
const wiredCallbacks = new WeakSet<object>();

export function isTerminalCallbackWired(onTerminal: object): boolean {
  return wiredCallbacks.has(onTerminal);
}

export function createTerminalGate(onTerminal?: (tool: TerminalToolName, result: string) => void): TerminalGate {
  if (onTerminal) wiredCallbacks.add(onTerminal);
  let state: 'open' | 'busy' | TerminalToolName = 'open';
  return {
    acquire(tool) {
      if (state === 'open') {
        state = 'busy';
        return null;
      }
      if (state === 'busy') return `ERROR: nothing was posted. Another terminal call is still running; do not call ${tool} again.`;
      return `ERROR: nothing was posted. ${state} already completed this review; do not call ${tool} again.`;
    },
    release() {
      if (state === 'busy') state = 'open';
    },
    complete(tool, result) {
      state = tool;
      onTerminal?.(tool, result);
    },
  };
}

export interface GhToolsDeps {
  readonly tokens: TokenSource;
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  /**
   * Mention-triggered runs only. When present, the review summary body
   * replaces the status comment (the bot's single top-level comment on
   * the PR) instead of becoming a separate review body. Inline comments
   * still go through the normal review submission.
   */
  readonly statusComment?: StatusComment;
  /** Writes the sticky review-state comment; shared by post_review and skip_review. */
  readonly stateWriter: StateCommentWriter;
  /**
   * Shared by post_review and skip_review so only one of them succeeds per
   * run. When absent, each tool gets a gate of its own.
   */
  readonly terminalGate?: TerminalGate;
  /**
   * After a successful state write, invoke the ready-label Lambda.
   * Failures are logged here and never fail the terminal call.
   */
  readonly syncReadyLabel?: () => Promise<void>;
}

/** Repositories gh_api_read may read: the PR's and the upstream the release branches come from. */
function readableRepos(ctx: PrContext): string[] {
  return [`${ctx.owner}/${ctx.repo}`, ...(ctx.upstreamRepo ? [ctx.upstreamRepo] : [])];
}

function checkState(deps: GhToolsDeps, state: ReviewState): string | null {
  return validateReviewState(state, deps.ctx.releaseLines?.map((r) => r.branch) ?? null)
    ?? tooLong('The rendered review state', renderReviewState(state, deps.ctx.headSha));
}

/**
 * Render + write the state comment. A failure is reported, not thrown,
 * and does not stop the terminal call from completing. A write that
 * failed once is likely to fail again, and a run that ends without a
 * terminal tool is redelivered and reviewed a second time. The write may
 * also have reached GitHub even though the request reported an error.
 */
async function writeState(deps: GhToolsDeps, state: ReviewState): Promise<{ url: string | null; error: string | null }> {
  try {
    const { url } = await deps.stateWriter.write(renderReviewState(state, deps.ctx.headSha));
    if (deps.syncReadyLabel) {
      try {
        await deps.syncReadyLabel();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ready-label] invoke failed: ${msg}`);
      }
    }
    return { url, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[review-state] write failed: ${msg}`);
    return { url: null, error: msg };
  }
}

/** Result field for a failed state write, telling the model the review is still done. */
function stateError(error: string | null): { state_comment_error?: string } {
  return error ? { state_comment_error: `${error} (the review is complete; do not call post_review or skip_review again)` } : {};
}

/** Status-comment text for a mention run that ends without an inline comment or a reply. */
const NOTHING_NEW = 'Review complete. Nothing new met the bar for an inline comment.';

function withStateLink(text: string, stateUrl: string | null): string {
  return stateUrl ? `${text}\n\nCurrent review state: ${stateUrl}` : text;
}

export function buildGhApiReadTool(deps: GhToolsDeps) {
  const repos = readableRepos(deps.ctx);
  return tool({
    name: 'gh_api_read',
    description:
`Read from the GitHub REST API. Only GET is allowed, only for ${[...new Set(repos)].join(' and ')}, and only for these endpoint paths:

- repos/OWNER/REPO/pulls/NUMBER: PR object
- repos/OWNER/REPO/pulls/NUMBER/files: changed files + patch hunks (paginated)
- repos/OWNER/REPO/pulls/NUMBER/reviews: submitted reviews
- repos/OWNER/REPO/pulls/NUMBER/reviews/ID: single review
- repos/OWNER/REPO/pulls/NUMBER/comments: inline review comments
- repos/OWNER/REPO/pulls/NUMBER/commits: PR commits
- repos/OWNER/REPO/issues/NUMBER/comments: issue/PR comments
- repos/OWNER/REPO/commits/SHA: commit
- repos/OWNER/REPO/contents/PATH: file at ref
- repos/OWNER/REPO/commits/SHA/check-runs: CI status
- repos/OWNER/REPO/check-runs/ID: CI detail

Do NOT include a leading slash. Append query strings inline, e.g. \`repos/OWNER/REPO/pulls/12/files?page=2&per_page=100\`. Percent-encoding, "..", and backslashes are refused.`,
    inputSchema: z.object({
      path: z.string().describe('API path without leading slash, e.g. "repos/OWNER/REPO/pulls/12"'),
    }),
    callback: async (input: { path: string }) => {
      const path = input.path.replace(/^\/+/, '');
      const problem = checkGhApiPath(path, repos);
      if (problem) return `ERROR: path "${path}" cannot be read: ${problem}`;
      const token = await deps.tokens.get();
      const r = await runBounded('gh', ['api', path, '--method', 'GET'], {
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
        timeoutMs: 30_000,
        maxBytes: 2_000_000,
      });
      if (r.truncated) return `${r.out}\nThe response was cut at 2 MB. Ask for a smaller page with per_page and page.`;
      if (r.code !== 0) return `gh api failed (${r.code}): ${r.err}\n${r.out}`;
      return r.out;
    },
  });
}

/**
 * Post the review. Atomic: one call, summary body + N inline comments.
 * Mirrors POST /repos/:o/:r/pulls/:n/reviews exactly.
 */
export function buildPostReviewTool(deps: GhToolsDeps) {
  const gate = deps.terminalGate ?? createTerminalGate();
  return tool({
    name: 'post_review',
    description:
`Post the final PR review atomically. Exactly one successful call per invocation. After a successful post_review or skip_review, later calls return an error and post nothing.

Supply:
- \`body\`: on a mention-triggered run, the short reply to the requester. Otherwise leave it empty; the summary lives in \`state\`.
- \`comments\`: an array of inline comments. Each item: { path, line, side?, body }. \`line\` is 1-indexed in the RIGHT file (side: "RIGHT" default). Use \`start_line\` + \`line\` for multi-line comments. Anchor only to lines present in the PR diff.
- \`state\`: the full current review state. The runtime renders it into the PR's single review-state comment and rewrites that comment on every run.

\`body\` and each comment body may be at most ${MAX_GITHUB_TEXT_CHARS} characters.

The review is posted as event="COMMENT". REQUEST_CHANGES and APPROVE are not available to the reviewer: block/approve decisions belong to humans. If you have no inline comments, call \`skip_review\` instead. Exception: on a mention-triggered run with a reply for the requester, call this tool with \`comments: []\` and the reply in \`body\`.

The review is anchored at the PR head SHA already loaded in the workspace context (${deps.ctx.headSha}). You do not pass it.`,
    inputSchema: z.object({
      body: z.string(),
      comments: z.array(z.object({
        path: z.string(),
        line: z.number().int().positive(),
        side: z.enum(['LEFT', 'RIGHT']).optional(),
        start_line: z.number().int().positive().optional(),
        start_side: z.enum(['LEFT', 'RIGHT']).optional(),
        body: z.string(),
      })).default([]),
      state: reviewStateSchema,
    }),
    callback: async (input) => {
      const invalid = tooLong('`body`', input.body)
        ?? input.comments.map((c, i) => tooLong(`comments[${i}].body`, c.body)).find((e) => e !== null)
        ?? checkState(deps, input.state);
      if (invalid) return `ERROR: nothing was posted. ${invalid}`;
      const taken = gate.acquire('post_review');
      if (taken) return taken;

      // Mention-triggered runs: the summary replaces the status comment
      // (the bot's existing top-level comment), so the PR gets one comment
      // instead of an ack plus a separate review body. Inline comments
      // still need a review object; it is submitted with an empty body.
      const summaryInStatusComment = deps.statusComment !== undefined;
      const reviewBody = summaryInStatusComment ? '' : input.body.trim();
      let review: { id: number; url: string } | null = null;
      // GitHub rejects an empty-body, zero-comment review, and with
      // nothing to anchor there is nothing a review object would add.
      if (input.comments.length > 0 || reviewBody) {
        try {
          const resp = await deps.octokit.pulls.createReview({
            owner: deps.ctx.owner,
            repo: deps.ctx.repo,
            pull_number: deps.ctx.prNumber,
            commit_id: deps.ctx.headSha,
            event: 'COMMENT',
            body: reviewBody,
            comments: input.comments,
          });
          review = { id: resp.data.id, url: resp.data.html_url };
        } catch (err) {
          gate.release();
          const e = err as { status?: number; message?: string; response?: { data?: { errors?: unknown } } } | null;
          const errors = e?.response?.data?.errors;
          return `ERROR status=${e?.status ?? '?'}: nothing was posted. ${e?.message ?? String(err)}${errors ? `\n${JSON.stringify(errors)}` : ''}`;
        }
      }

      // A failed state write is only reported; see writeState.
      const state = await writeState(deps, input.state);
      if (deps.statusComment) {
        const reply = stripStateMarker(input.body).trim()
          || (input.comments.length > 0 ? `Review complete. See the ${input.comments.length} inline comment(s).` : NOTHING_NEW);
        await deps.statusComment.finish(withStateLink(reply, state.url));
      }
      const result = JSON.stringify({
        ok: true,
        review_id: review?.id ?? null,
        url: review?.url ?? null,
        state_comment_url: state.url,
        ...stateError(state.error),
      });
      gate.complete('post_review', result);
      return result;
    },
  });
}

/**
 * End the review without inline comments. The state comment is still
 * written, so the PR shows the current verdict.
 */
export function buildSkipTool(deps: GhToolsDeps) {
  const gate = deps.terminalGate ?? createTerminalGate();
  return tool({
    name: 'skip_review',
    description:
`End the review without inline comments. Call this when nothing in this run warrants an inline comment. Do NOT use this as cover for missing findings. After a successful post_review or skip_review, later calls return an error and post nothing.

Posts no review, but still writes \`state\` to the PR's review-state comment, so the PR shows the current verdict (for example "ready for human review", or open findings carried over from an earlier run).`,
    inputSchema: z.object({
      reason: z.string().min(1).describe('One-sentence rationale. Logged, and on a mention-triggered run shown to the requester.'),
      state: reviewStateSchema,
    }),
    callback: async (input) => {
      const invalid = tooLong('`reason`', input.reason) ?? checkState(deps, input.state);
      if (invalid) return `ERROR: nothing was posted. ${invalid}`;
      const taken = gate.acquire('skip_review');
      if (taken) return taken;
      // A failed state write is only reported; see writeState.
      const state = await writeState(deps, input.state);
      // Mention-triggered runs: someone asked and is watching the status
      // comment, and a silent exit would leave it on "still working".
      if (deps.statusComment) {
        await deps.statusComment.finish(withStateLink(`${NOTHING_NEW} (${stripStateMarker(input.reason).trim()})`, state.url));
      }
      const result = JSON.stringify({
        ok: true,
        skipped: true,
        reason: input.reason,
        pr: `${deps.ctx.owner}/${deps.ctx.repo}#${deps.ctx.prNumber}`,
        state_comment_url: state.url,
        ...stateError(state.error),
      });
      gate.complete('skip_review', result);
      return result;
    },
  });
}
