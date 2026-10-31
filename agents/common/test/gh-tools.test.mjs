import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { buildPostReviewTool, buildSkipTool, checkGhApiPath, createTerminalGate, isTerminalCallbackWired, MAX_GITHUB_TEXT_CHARS } = await import('../src/tools/gh.ts');

const ctx = {
  owner: 'valkey-io', repo: 'valkey', prNumber: 7, headSha: 'abc123',
  upstreamRepo: 'valkey-io/valkey',
  releaseLines: [{ branch: '9.0', lastCommit: '2026-09-01' }, { branch: '8.1', lastCommit: '2026-08-01' }],
};

const state = (overrides = {}) => ({
  status: 'needs_work',
  summary: 'One open finding.',
  risk: 'low',
  risk_reason: 'Only the error path changes.',
  findings: [{ location: 'src/server.c:10', summary: 'Leak on error.', blocking: true, resolved: false }],
  backport: { verdict: 'not_needed', branches: [], reason: 'New code.' },
  direction: '',
  ...overrides,
});

function harness({ createReview, stateWrite, statusComment, syncReadyLabel } = {}) {
  const reviews = [];
  const stateBodies = [];
  const terminal = [];
  const readyLabel = [];
  const deps = {
    ctx,
    tokens: { get: async () => 'token' },
    octokit: {
      pulls: {
        createReview: createReview ?? (async (args) => {
          reviews.push(args);
          return { data: { id: reviews.length, html_url: `https://github.com/r/${reviews.length}` } };
        }),
      },
    },
    stateWriter: {
      write: stateWrite ?? (async (body) => {
        stateBodies.push(body);
        return { id: 99, url: 'https://github.com/state' };
      }),
    },
    statusComment,
    terminalGate: createTerminalGate((tool, result) => terminal.push({ tool, result })),
    syncReadyLabel: syncReadyLabel ?? (async () => { readyLabel.push(true); }),
  };
  return { post: buildPostReviewTool(deps), skip: buildSkipTool(deps), reviews, stateBodies, terminal, readyLabel };
}

const comment = { path: 'src/server.c', line: 10, body: 'This leaks `buf` when `read` fails.' };

test('a successful post_review is terminal, and a second one posts nothing', async () => {
  const h = harness();
  const first = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.equal(JSON.parse(first).ok, true);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.stateBodies.length, 1);
  assert.deepEqual(h.terminal.map((t) => t.tool), ['post_review']);
  assert.equal(h.terminal[0].result, first);

  const second = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(second, /^ERROR: nothing was posted\. post_review already completed/);
  const skip = await h.skip.invoke({ reason: 'nothing new', state: state() });
  assert.match(skip, /^ERROR: nothing was posted\./);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.stateBodies.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('a failed post_review is not terminal and can be retried', async () => {
  let fail = true;
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      if (fail) throw Object.assign(new Error('Unprocessable Entity'), { status: 422, response: { data: { errors: ['line not in diff'] } } });
      reviews.push(args);
      return { data: { id: 1, html_url: 'https://github.com/r/1' } };
    },
  });
  const failed = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(failed, /^ERROR status=422: nothing was posted/);
  assert.match(failed, /line not in diff/);
  assert.equal(h.terminal.length, 0);
  assert.equal(h.stateBodies.length, 0);

  fail = false;
  assert.equal(JSON.parse(await h.post.invoke({ body: '', comments: [comment], state: state() })).ok, true);
  assert.equal(reviews.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('concurrent terminal calls post once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reviews = [];
  const h = harness({
    createReview: async (args) => {
      reviews.push(args);
      await gate;
      return { data: { id: 1, html_url: 'https://github.com/r/1' } };
    },
  });
  const first = h.post.invoke({ body: '', comments: [comment], state: state() });
  const second = await h.post.invoke({ body: '', comments: [comment], state: state() });
  assert.match(second, /still running/);
  release();
  assert.equal(JSON.parse(await first).ok, true);
  assert.equal(reviews.length, 1);
  assert.equal(h.terminal.length, 1);
});

test('an invalid state or oversized text posts nothing and keeps the gate open', async () => {
  const h = harness();
  const ready = state({ status: 'ready_for_human_review' });
  assert.match(await h.post.invoke({ body: '', comments: [comment], state: ready }), /^ERROR: nothing was posted\..*blocking finding/);
  const huge = 'x'.repeat(MAX_GITHUB_TEXT_CHARS + 1);
  assert.match(await h.post.invoke({ body: huge, comments: [comment], state: state() }), /`body` is 60001 characters/);
  assert.match(await h.post.invoke({ body: '', comments: [comment, { ...comment, body: huge }], state: state() }), /comments\[1\]\.body is 60001 characters/);
  assert.match(await h.skip.invoke({ reason: huge, state: state() }), /`reason` is 60001 characters/);
  const longState = state({ summary: huge });
  assert.match(await h.skip.invoke({ reason: 'r', state: longState }), /rendered review state is \d+ characters/);
  const badBranch = state({ backport: { verdict: 'needed', branches: ['7.2'], reason: 'Old bug.' } });
  assert.match(await h.skip.invoke({ reason: 'r', state: badBranch }), /"7\.2".*9\.0, 8\.1/);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.stateBodies.length, 0);
  assert.equal(h.terminal.length, 0);

  assert.equal(JSON.parse(await h.skip.invoke({ reason: 'Nothing new.', state: state() })).skipped, true);
  assert.deepEqual(h.terminal.map((t) => t.tool), ['skip_review']);
});

const failingStateWrite = async () => { throw new Error('Bad credentials'); };

test('skip_review still completes the review when only the state comment write fails', async () => {
  const finished = [];
  const h = harness({ stateWrite: failingStateWrite, statusComment: { finish: async (body) => { finished.push(body); } } });
  const raw = await h.skip.invoke({ reason: 'Nothing new.', state: state() });
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.state_comment_url, null);
  assert.match(result.state_comment_error, /Bad credentials.*do not call post_review or skip_review again/);
  assert.deepEqual(h.terminal, [{ tool: 'skip_review', result: raw }]);
  // The requester still gets an answer, without a link to a state comment that was not written.
  assert.deepEqual(finished, ['Review complete. Nothing new met the bar for an inline comment. (Nothing new.)']);

  assert.match(await h.skip.invoke({ reason: 'again', state: state() }), /^ERROR: nothing was posted\. skip_review already completed/);
  assert.match(await h.post.invoke({ body: '', comments: [comment], state: state() }), /^ERROR: nothing was posted\. skip_review already completed/);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.terminal.length, 1);
});

test('post_review still completes the review when only the state comment write fails', async () => {
  const posted = harness({ stateWrite: failingStateWrite });
  const raw = await posted.post.invoke({ body: '', comments: [comment], state: state() });
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.review_id, 1);
  assert.match(result.state_comment_error, /Bad credentials.*do not call post_review or skip_review again/);
  assert.equal(posted.reviews.length, 1);
  assert.deepEqual(posted.terminal, [{ tool: 'post_review', result: raw }]);
  assert.match(await posted.post.invoke({ body: '', comments: [comment], state: state() }), /^ERROR: nothing was posted\. post_review already completed/);
  assert.equal(posted.reviews.length, 1);

  // With no inline comments and no body there is no review object; the call still completes.
  const stateOnly = harness({ stateWrite: failingStateWrite });
  const bare = JSON.parse(await stateOnly.post.invoke({ body: '', comments: [], state: state() }));
  assert.equal(bare.ok, true);
  assert.equal(bare.review_id, null);
  assert.match(bare.state_comment_error, /Bad credentials/);
  assert.equal(stateOnly.reviews.length, 0);
  assert.deepEqual(stateOnly.terminal.map((t) => t.tool), ['post_review']);
});

test('a successful state write leaves no state_comment_error', async () => {
  const h = harness();
  assert.equal('state_comment_error' in JSON.parse(await h.skip.invoke({ reason: 'r', state: state() })), false);
  const other = harness();
  assert.equal('state_comment_error' in JSON.parse(await other.post.invoke({ body: '', comments: [comment], state: state() })), false);
});

test('on mention runs the reply replaces the status comment and the review body stays empty', async () => {
  const finished = [];
  const h = harness({ statusComment: { finish: async (body) => { finished.push(body); } } });
  await h.post.invoke({ body: 'Fixed in the latest push, one nit left.', comments: [comment], state: state() });
  assert.equal(h.reviews[0].body, '');
  assert.deepEqual(finished, ['Fixed in the latest push, one nit left.\n\nCurrent review state: https://github.com/state']);
});

test('the post_review description allows a reply-only call on mention runs, as the prompts do', () => {
  const { description } = harness().post.toolSpec;
  assert.match(description, /If you have no inline comments, call `skip_review` instead\. Exception: on a mention-triggered run with a reply for the requester, call this tool with `comments: \[\]` and the reply in `body`\./);
});

test('on mention runs an empty reply falls back to a line that fits what was posted', async () => {
  const finished = [];
  const statusComment = { finish: async (body) => { finished.push(body); } };
  const withComments = harness({ statusComment });
  await withComments.post.invoke({ body: '  ', comments: [comment, { ...comment, line: 12 }], state: state() });
  const bare = harness({ statusComment });
  await bare.post.invoke({ body: '', comments: [], state: state() });
  assert.equal(bare.reviews.length, 0);
  assert.deepEqual(finished, [
    'Review complete. See the 2 inline comment(s).\n\nCurrent review state: https://github.com/state',
    'Review complete. Nothing new met the bar for an inline comment.\n\nCurrent review state: https://github.com/state',
  ]);
});

test('model text in the status comment cannot carry the state marker', async () => {
  const { STATE_MARKER } = await import('../src/review-state.ts');
  const finished = [];
  const statusComment = { finish: async (body) => { finished.push(body); } };
  await harness({ statusComment }).post.invoke({ body: `${STATE_MARKER}\nAll fixed.`, comments: [comment], state: state() });
  await harness({ statusComment }).skip.invoke({ reason: `Nothing new ${STATE_MARKER}`, state: state() });
  assert.deepEqual(finished, [
    'All fixed.\n\nCurrent review state: https://github.com/state',
    'Review complete. Nothing new met the bar for an inline comment. (Nothing new)\n\nCurrent review state: https://github.com/state',
  ]);
});

test('the run loop can tell whether its terminal callback reached the tools', async () => {
  const { assembleCommonTools } = await import('../src/tools/index.ts');
  const opts = { ctx: { ...ctx, workspacePath: process.cwd() }, octokit: {}, tokens: { get: async () => 'token' } };
  const forwarded = () => {};
  await assembleCommonTools({ ...opts, onTerminal: forwarded });
  assert.equal(isTerminalCallbackWired(forwarded), true);

  const dropped = () => {};
  await assembleCommonTools(opts);
  assert.equal(isTerminalCallbackWired(dropped), false);
});

test('a successful state write invokes the ready-label Lambda', async () => {
  const skip = harness();
  await skip.skip.invoke({ reason: 'Nothing new.', state: state() });
  assert.deepEqual(skip.readyLabel, [true]);

  const post = harness();
  await post.post.invoke({ body: '', comments: [comment], state: state() });
  assert.deepEqual(post.readyLabel, [true]);
});

test('a failed state write does not invoke the ready-label Lambda', async () => {
  const skip = harness({ stateWrite: failingStateWrite });
  await skip.skip.invoke({ reason: 'Nothing new.', state: state() });
  assert.deepEqual(skip.readyLabel, []);

  const post = harness({ stateWrite: failingStateWrite });
  await post.post.invoke({ body: '', comments: [comment], state: state() });
  assert.deepEqual(post.readyLabel, []);
});

test('a failed ready-label invoke does not fail the review', async () => {
  const h = harness({
    syncReadyLabel: async () => { throw new Error('lambda down'); },
  });
  const raw = await h.skip.invoke({ reason: 'Nothing new.', state: state() });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state_comment_url, 'https://github.com/state');
  assert.equal('state_comment_error' in parsed, false);
  assert.equal(h.terminal.length, 1);
});

test('gh_api_read paths must name an allowed repository and endpoint', () => {
  const repos = ['avalkey/valkey', 'valkey-io/valkey'];
  assert.equal(checkGhApiPath('repos/avalkey/valkey/pulls/12/files?page=2&per_page=100', repos), null);
  assert.equal(checkGhApiPath('repos/Valkey-IO/Valkey/commits/abc123/check-runs', repos), null);
  assert.equal(checkGhApiPath('repos/valkey-io/valkey/contents/src/server.c?ref=9.0', repos), null);

  assert.match(checkGhApiPath('repos/someone/else/pulls/1', repos), /only these repositories/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/pulls/1/../../../../user', repos), /"\.\."/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/contents/a%2E%2E%2Fb', repos), /percent-encoded/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/contents/a\\b', repos), /backslashes/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/pulls/1 --method POST', repos), /whitespace/);
  assert.match(checkGhApiPath('repos/valkey-io/valkey/actions/secrets', repos), /not on the allowlist/);
  assert.match(checkGhApiPath('user/repos', repos), /must start with repos/);
  assert.match(checkGhApiPath('repos/{owner}/{repo}/pulls/1', repos), /only these repositories/);
});
