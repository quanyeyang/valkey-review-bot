import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './support/ts-resolve.mjs';
import { fakeGitHub } from './support/fakes.mjs';

const {
  LABEL_PERMISSIONS, MAX_RECONCILE_ATTEMPTS, STATE_MARKER, createReadyLabelApplier,
  humanAnsweredAfter, openPrWideConcerns, parseReadyState, reconcileReadyLabel,
  runReadyLabelHandler, threadsAddressed, wantReadyLabel,
} = await import('../src/ready-label.ts');
const { botMatcher } = await import('../src/config.ts');

const REPO = 'example-org/valkey';
const BOT = 'example-reviewer[bot]';
const LABEL = 'ready-for-human-review';
const INSTALLATION = 42;
const APP_ID = 123456;
const HEAD = 'abcdef0123456789deadbeefcafebabe01234567';
const PREFIX = HEAD.slice(0, 10);
const isBot = botMatcher(BOT, new Set(['coderabbitai', 'coderabbitai[bot]']));

const reviewStateSrc = fs.readFileSync(
  path.join(fileURLToPath(new URL('.', import.meta.url)), '../../agents/common/src/review-state.ts'),
  'utf8',
);

function stateBody({ ready = true, sha = HEAD } = {}) {
  const line = ready ? '**Ready for human review.**' : '**Not ready for human review yet.**';
  return `${STATE_MARKER}\n### Review state\n\n${line}\nNothing open.\n\n<sub>Updated for ${sha.slice(0, 10)} at 2026-10-01 12:34 UTC. The bot rewrites this comment on every review.</sub>`;
}

function appComment(overrides = {}) {
  const {
    ready = true, sha = HEAD, login = BOT, appId = APP_ID, body,
    created_at = '2026-10-01T12:00:00Z', updated_at = '2026-10-01T12:34:00Z',
  } = overrides;
  return {
    body: body ?? stateBody({ ready, sha }),
    user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
    performed_via_github_app: { id: appId },
    created_at,
    updated_at,
  };
}

function needsWorkPrWide({ sha = HEAD, direction = false } = {}) {
  const findings = direction
    ? '**Open findings:** none.\n\n**Backport:** Not needed. x\n\n**Direction**\nUse a pool instead.\n'
    : '**Open findings (1)**\n- DCO is missing.\n\n**Backport:** Not needed. x\n';
  return `${STATE_MARKER}\n### Review state\n\n**Not ready for human review yet.**\nOne blocking finding is open.\n\n**Risk:** High. x\n\n${findings}\n<sub>Updated for ${sha.slice(0, 10)} at 2026-10-01 12:34 UTC. The bot rewrites this comment on every review.</sub>`;
}

function humanIssueComment({
  created_at = '2026-10-01T13:00:00Z', login = 'maintainer', body = 'Disagree: the DCO is on the commits.',
} = {}) {
  return {
    body,
    user: { login, type: 'User' },
    created_at,
    updated_at: created_at,
  };
}

function pullJson({ state = 'open', draft = false, sha = HEAD, labels = [] } = {}) {
  return { status: 200, json: { state, draft, head: { sha }, labels: labels.map((name) => ({ name })) } };
}

function threadsData(nodes) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
      },
    },
  };
}

function thread({ resolved = false, authors = ['example-reviewer'], bodies = [] } = {}) {
  return {
    isResolved: resolved,
    comments: {
      nodes: authors.map((login, i) => {
        const bot = login.endsWith('[bot]') || login === 'coderabbitai' || login === 'example-reviewer' || login === 'other-reviewer';
        return {
          body: bodies[i],
          author: {
            __typename: bot ? 'Bot' : 'User',
            login: login.replace(/\[bot\]$/i, ''),
          },
        };
      }),
    },
  };
}

const installed = (id = INSTALLATION, login = 'example-org') => ({ status: 200, json: { id, account: { login } } });

function githubRoutes({
  pull = pullJson(),
  comments = [appComment()],
  addStatus = 200,
  addJson = {},
  deleteStatus = 200,
  installation = installed(),
} = {}) {
  return {
    [`GET repos/${REPO}/installation`]: installation,
    [`GET repos/${REPO}/pulls/7`]: pull,
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: comments },
    [`POST repos/${REPO}/issues/7/labels`]: { status: addStatus, json: addJson },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: { status: deleteStatus, json: {} },
  };
}

function setupApplier({
  github = githubRoutes(),
  graphql = threadsData([]),
  labelsByRepo = { [REPO]: LABEL },
  allowedRepos = [REPO],
} = {}) {
  const issued = [];
  const logs = [];
  const api = fakeGitHub(github);
  const apply = createReadyLabelApplier({
    allowedRepos,
    labelsByRepo,
    appId: APP_ID,
    botLogin: BOT,
    knownBotLogins: new Set(['coderabbitai', 'coderabbitai[bot]']),
    appApi: async () => api,
    issueToken: async (request) => {
      issued.push(request);
      return { token: 'ghs_label', expiresAt: '2026-10-13T13:00:00Z' };
    },
    githubApi: (token) => {
      assert.equal(token, 'ghs_label');
      return api;
    },
    graphql: async (token, _query, variables) => {
      assert.equal(token, 'ghs_label');
      return typeof graphql === 'function' ? graphql(variables) : graphql;
    },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { apply, issued, logs, api };
}

async function reconcile(opts) {
  const github = githubRoutes(opts);
  const api = fakeGitHub(github);
  const logs = [];
  const decision = await reconcileReadyLabel({
    api,
    graphql: async () => (typeof opts.graphql === 'function' ? opts.graphql() : (opts.graphql ?? threadsData([]))),
    repo: REPO,
    prNumber: 7,
    appId: APP_ID,
    botLogin: BOT,
    isBot,
    label: LABEL,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { decision, api, logs };
}

test('the state marker and ready lines stay identical to the runtime renderer', () => {
  assert.match(reviewStateSrc, new RegExp(`export const STATE_MARKER = '${STATE_MARKER}'`));
  assert.match(reviewStateSrc, /\*\*Ready for human review\.\*\*/);
  assert.match(reviewStateSrc, /\*\*Not ready for human review yet\.\*\*/);
  assert.match(reviewStateSrc, /Updated for \$\{headSha\.slice\(0, 10\)\} at/);
});

test('parseReadyState reads the renderer\'s ready line and 10-hex head prefix', () => {
  assert.deepEqual(parseReadyState(stateBody({ ready: true })), { ready: true, headPrefix: PREFIX });
  assert.deepEqual(parseReadyState(stateBody({ ready: false })), { ready: false, headPrefix: PREFIX });
  assert.equal(parseReadyState('**Ready for human review.**\nUpdated for abcdef0123 at'), undefined);
  assert.equal(parseReadyState(`${STATE_MARKER}\n**Ready for human review.**`), undefined);
});

test('wantReadyLabel requires an open non-draft PR and a completed review at this head', () => {
  const ok = {
    prState: 'open', draft: false, headSha: HEAD,
    state: { ready: true, headPrefix: PREFIX },
    threadsOk: true, hasAppThread: false, blockingPrWide: false, prWideAnswered: false,
  };
  assert.equal(wantReadyLabel(ok), true);
  assert.equal(wantReadyLabel({ ...ok, prState: 'closed' }), false);
  assert.equal(wantReadyLabel({ ...ok, draft: true }), false);
  assert.equal(wantReadyLabel({ ...ok, state: { ready: false, headPrefix: PREFIX }, hasAppThread: true }), true);
  assert.equal(wantReadyLabel({ ...ok, state: { ready: false, headPrefix: PREFIX } }), false, 'empty needs_work is not a handoff');
  assert.equal(wantReadyLabel({ ...ok, state: { ready: false, headPrefix: PREFIX }, blockingPrWide: true, prWideAnswered: true }), true);
  assert.equal(wantReadyLabel({ ...ok, state: { ready: false, headPrefix: PREFIX }, blockingPrWide: true }), false);
  assert.equal(wantReadyLabel({ ...ok, blockingPrWide: true }), false, 'ready with a blocking PR-wide finding stays off');
  assert.equal(wantReadyLabel({ ...ok, state: { ready: true, headPrefix: 'aaaaaaaaaa' } }), false);
  assert.equal(wantReadyLabel({ ...ok, state: undefined }), false);
  assert.equal(wantReadyLabel({ ...ok, threadsOk: false, hasAppThread: true }), false);
});

test('openPrWideConcerns follows the renderer\'s PR-wide lines and Direction', () => {
  assert.match(reviewStateSrc, /const where = location \? /);
  assert.match(reviewStateSrc, /\*\*Direction\*\*/);
  assert.equal(openPrWideConcerns(stateBody({ ready: true })), false);
  assert.equal(openPrWideConcerns(stateBody({ ready: false })), false);
  assert.equal(openPrWideConcerns(needsWorkPrWide()), true);
  assert.equal(openPrWideConcerns(needsWorkPrWide({ direction: true })), true);
  assert.equal(openPrWideConcerns(`${STATE_MARKER}\n**Open findings (1)**\n- \`src/server.c:10\` Leak.\n`), false);
  assert.equal(openPrWideConcerns(`${STATE_MARKER}\n**Open findings (1)**\n- (minor) Commit title is long.\n`), false);
});

test('humanAnsweredAfter counts a non-bot issue comment created after the state rewrite', () => {
  const state = appComment();
  assert.equal(humanAnsweredAfter([state], state, isBot, BOT), false);
  assert.equal(humanAnsweredAfter([state, humanIssueComment()], state, isBot, BOT), true);
  assert.equal(humanAnsweredAfter([state, humanIssueComment({ created_at: '2026-10-01T12:00:00Z' })], state, isBot, BOT), false);
  assert.equal(humanAnsweredAfter([state, humanIssueComment({ login: BOT })], state, isBot, BOT), false);
  assert.equal(humanAnsweredAfter([state, humanIssueComment({ body: '@example-reviewer please review the new test' })], state, isBot, BOT), false);
});

test('threadsAddressed: resolve or a later human reply; bot-only does not; other bots\' threads are ignored', () => {
  const ours = (comments, resolved = false) => ({ isResolved: resolved, comments });
  const bot = { author: { login: 'example-reviewer', type: 'Bot' } };
  const human = { author: { login: 'maintainer', type: 'User' } };
  const command = { author: { login: 'maintainer', type: 'User' }, body: '@example-reviewer please recheck' };
  const rabbit = { author: { login: 'coderabbitai', type: 'User' } };
  const otherBot = { author: { login: 'other-reviewer[bot]', type: 'Bot' } };

  assert.equal(threadsAddressed([], BOT, isBot), true);
  assert.equal(threadsAddressed([ours([bot], true)], BOT, isBot), true);
  assert.equal(threadsAddressed([ours([bot, human])], BOT, isBot), true);
  assert.equal(threadsAddressed([ours([bot])], BOT, isBot), false);
  assert.equal(threadsAddressed([ours([{ author: { login: 'example-reviewer', type: 'User' } }])], BOT, isBot), true, 'a User with the slug is not this App');
  assert.equal(threadsAddressed([ours([bot, command])], BOT, isBot), false, 'an @mention is not an answer');
  assert.equal(threadsAddressed([ours([bot, rabbit])], BOT, isBot), false);
  assert.equal(threadsAddressed([ours([bot, otherBot])], BOT, isBot), false);
  assert.equal(threadsAddressed([ours([otherBot])], BOT, isBot), true, 'a thread we did not start is ignored');
  assert.equal(threadsAddressed([ours([bot], true), ours([bot, human])], BOT, isBot), true);
  assert.equal(threadsAddressed([ours([bot], true), ours([bot])], BOT, isBot), false);
});

test('an open ready PR at this head with no unaddressed threads gets the label', async () => {
  const { apply, issued, api } = setupApplier();
  assert.deepEqual(await apply({ installation_id: INSTALLATION, repo: REPO, pr_number: 7, label: 'ignored' }), {
    ok: true, decision: 'added',
  });
  assert.deepEqual(issued, [{
    installationId: INSTALLATION,
    repositoryNames: ['valkey'],
    permissions: LABEL_PERMISSIONS,
  }]);
  assert.equal('contents' in LABEL_PERMISSIONS, false);
  assert.equal('issues' in LABEL_PERMISSIONS, false);
  assert.equal(LABEL_PERMISSIONS.pull_requests, 'write');
  const post = api.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { labels: [LABEL] });
});

test('unanswered findings at this head remove the label even when the agent still says needs_work', async () => {
  const { decision, api } = await reconcile({
    pull: pullJson({ labels: [LABEL] }),
    comments: [appComment({ ready: false })],
    graphql: threadsData([thread({ authors: [BOT] })]),
  });
  assert.equal(decision, 'removed');
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('a human reply on this App\'s thread adds the label while the agent still says needs_work', async () => {
  const { decision, api } = await reconcile({
    comments: [appComment({ ready: false })],
    graphql: threadsData([thread({ authors: [BOT, 'maintainer'] })]),
  });
  assert.equal(decision, 'added');
  assert.ok(api.calls.some((c) => c.method === 'POST'));
});

test('a later human issue comment addresses a PR-wide finding', async () => {
  const { decision } = await reconcile({
    comments: [appComment({ ready: false, body: needsWorkPrWide() }), humanIssueComment()],
  });
  assert.equal(decision, 'added');
});

test('a PR-wide finding with no later human comment does not get the label', async () => {
  const { decision, api } = await reconcile({
    comments: [appComment({ ready: false, body: needsWorkPrWide() })],
  });
  assert.equal(decision, 'already-off');
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('a human comment from before the state rewrite does not address a PR-wide finding', async () => {
  const { decision } = await reconcile({
    comments: [
      appComment({ ready: false, body: needsWorkPrWide() }),
      humanIssueComment({ created_at: '2026-10-01T12:00:00Z' }),
    ],
  });
  assert.equal(decision, 'already-off');
});

test('a ready comment for another head is not this head', async () => {
  const other = 'aaaaaaaaaabbbbbbbbbbccccccccccccccccdddddddd';
  const { decision } = await reconcile({
    pull: pullJson({ labels: [LABEL] }),
    comments: [appComment({ sha: other })],
  });
  assert.equal(decision, 'removed');
});

test('a forged comment that copies the marker without our bot login is ignored', async () => {
  const { decision, api } = await reconcile({
    comments: [appComment({ login: 'attacker' })],
  });
  assert.equal(decision, 'already-off');
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('draft and closed pull requests drop the label', async () => {
  for (const pull of [pullJson({ draft: true, labels: [LABEL] }), pullJson({ state: 'closed', labels: [LABEL] })]) {
    const { decision } = await reconcile({ pull, comments: [appComment()] });
    assert.equal(decision, 'removed');
  }
});

test('thread matrix: resolved, human reply, bot-only, other-bot ignored', async () => {
  const readyOn = { pull: pullJson({ labels: [] }), comments: [appComment()] };
  assert.equal((await reconcile({ ...readyOn, graphql: threadsData([thread({ resolved: true })]) })).decision, 'added');
  assert.equal((await reconcile({
    ...readyOn, graphql: threadsData([thread({ authors: [BOT, 'maintainer'] })]),
  })).decision, 'added');
  assert.equal((await reconcile({
    ...readyOn, graphql: threadsData([thread({ authors: [BOT] })]),
  })).decision, 'already-off');
  assert.equal((await reconcile({
    ...readyOn, graphql: threadsData([thread({ authors: [BOT, 'coderabbitai'] })]),
  })).decision, 'already-off');
  assert.equal((await reconcile({
    ...readyOn, graphql: threadsData([thread({ authors: ['other-reviewer[bot]'] })]),
  })).decision, 'added');
});

test('a missing repository label is logged and not created', async () => {
  const { decision, logs, api } = await reconcile({ addStatus: 404, comments: [appComment()] });
  assert.equal(decision, 'missing-label');
  assert.match(logs.join('\n'), /missing-label/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(!api.calls.some((c) => c.method === 'DELETE'));
});

test('the caller cannot supply the label name', async () => {
  const { apply, api } = setupApplier();
  await apply({ installation_id: INSTALLATION, repo: REPO, pr_number: 7, label: 'pwned' });
  const post = api.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { labels: [LABEL] });
  assert.equal(JSON.stringify(post.body).includes('pwned'), false);
});

test('the result never includes a token', async () => {
  const { apply } = setupApplier();
  const result = await apply({ installation_id: INSTALLATION, repo: REPO, pr_number: 7 });
  assert.equal('token' in result, false);
  assert.equal(JSON.stringify(result).includes('ghs_label'), false);
});

test('refuses an installation that is not the App installation on the repository', async () => {
  const { apply, issued } = setupApplier();
  assert.deepEqual(await apply({ installation_id: 99, repo: REPO, pr_number: 7 }), {
    error: `installation 99 is not the App's installation on ${REPO}`,
  });
  assert.deepEqual(issued, []);
});

test('refuses repositories outside the routed set without calling GitHub', async () => {
  const { apply, api, issued } = setupApplier();
  assert.deepEqual(await apply({ installation_id: INSTALLATION, repo: 'example-org/other', pr_number: 7 }), {
    error: 'repo example-org/other is not a routed repository',
  });
  assert.deepEqual(api.calls, []);
  assert.deepEqual(issued, []);
});

test('refuses a malformed request without calling GitHub', async () => {
  const { apply, api } = setupApplier();
  assert.deepEqual(await apply({ installation_id: INSTALLATION, repo: REPO }), { error: 'invalid pr_number' });
  assert.deepEqual(await apply({ repo: REPO, pr_number: 7 }), { error: 'invalid installation_id' });
  assert.deepEqual(await apply({ installation_id: INSTALLATION, repo: 'valkey', pr_number: 7 }), { error: 'repo must be "owner/name"' });
  assert.deepEqual(api.calls, []);
});

test('a stale invocation does not add the label after a newer head has been reconciled', async () => {
  const headB = 'bbbbbbbbbb0123456789deadbeefcafebabe00000000';
  let sha = HEAD;
  const labels = [];
  let resolveGraphql;
  const blocked = new Promise((r) => { resolveGraphql = r; });
  let graphqlCalls = 0;
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const run = () => reconcileReadyLabel({
    api,
    graphql: async () => {
      graphqlCalls += 1;
      if (graphqlCalls === 1) await blocked;
      return threadsData([]);
    },
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  });

  const first = run();
  for (let i = 0; i < 50 && graphqlCalls < 1; i++) await new Promise((r) => setImmediate(r));
  assert.equal(graphqlCalls, 1);

  sha = headB;
  assert.equal(await run(), 'already-off');
  resolveGraphql();
  assert.equal(await first, 'already-off');
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
  assert.deepEqual(labels, []);
});

test('an add on a head that then moves is undone on the next attempt', async () => {
  const headB = 'bbbbbbbbbb0123456789deadbeefcafebabe00000000';
  const labels = [];
  const shas = [HEAD, HEAD, headB, headB, headB];
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha: shas.shift() ?? headB, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const decision = await reconcileReadyLabel({
    api, graphql: async () => threadsData([]),
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  });
  assert.equal(decision, 'removed');
  assert.ok(api.calls.some((c) => c.method === 'POST'));
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(labels, []);
});

test('an add on the same head is undone when threads become unaddressed before the reconcile returns', async () => {
  const labels = [];
  let graphqlCalls = 0;
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha: HEAD, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const decision = await reconcileReadyLabel({
    api,
    graphql: async () => {
      graphqlCalls += 1;
      return graphqlCalls === 1
        ? threadsData([thread({ resolved: true })])
        : threadsData([thread({ authors: [BOT] })]);
    },
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  });
  assert.equal(decision, 'removed');
  assert.ok(api.calls.some((c) => c.method === 'POST'));
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(labels, []);
});

test('a paused resolve does not leave the label on after a later unresolve at the same head', async () => {
  const labels = [];
  let resolveGraphql;
  const blocked = new Promise((r) => { resolveGraphql = r; });
  let graphqlCalls = 0;
  const resolved = threadsData([thread({ resolved: true })]);
  const unresolved = threadsData([thread({ authors: [BOT] })]);
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha: HEAD, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const run = () => reconcileReadyLabel({
    api,
    graphql: async () => {
      graphqlCalls += 1;
      if (graphqlCalls === 1) {
        await blocked;
        return resolved;
      }
      return unresolved;
    },
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  });

  const first = run();
  for (let i = 0; i < 50 && graphqlCalls < 1; i++) await new Promise((r) => setImmediate(r));
  assert.equal(graphqlCalls, 1);

  assert.equal(await run(), 'already-off');
  resolveGraphql();
  assert.equal(await first, 'removed');
  assert.deepEqual(labels, []);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
});

test('an add on the last attempt is removed before returning stale-head', async () => {
  const headB = 'bbbbbbbbbb0123456789deadbeefcafebabe00000000';
  const labels = [];
  const shas = [];
  for (let i = 0; i < MAX_RECONCILE_ATTEMPTS - 1; i++) shas.push(HEAD, headB);
  shas.push(HEAD, HEAD, headB);
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha: shas.shift() ?? headB, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const decision = await reconcileReadyLabel({
    api, graphql: async () => threadsData([]),
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  });
  assert.equal(decision, 'stale-head');
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(labels, []);
  assert.equal(shas.length, 0);
});

test('a bare GraphQL bot login is this App and an open thread blocks the label', async () => {
  const { decision, api } = await reconcile({
    graphql: threadsData([thread({ authors: ['example-reviewer'] })]),
  });
  assert.equal(decision, 'already-off');
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('needs_work with nothing open does not get the label', async () => {
  const { decision, api } = await reconcile({ comments: [appComment({ ready: false })] });
  assert.equal(decision, 'already-off');
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('a PR-wide minor does not block a needs_work handoff and does not qualify alone', async () => {
  const minor = needsWorkPrWide().replace('- DCO is missing.', '- (minor) Commit title is long.');
  const alone = await reconcile({ comments: [appComment({ ready: false, body: minor })] });
  assert.equal(alone.decision, 'already-off');
  const handed = await reconcile({
    comments: [appComment({ ready: false, body: minor })],
    graphql: threadsData([thread({ authors: ['example-reviewer', 'maintainer'] })]),
  });
  assert.equal(handed.decision, 'added');
});

test('an @mention does not answer a needs_work thread or a PR-wide finding', async () => {
  const threadOnly = await reconcile({
    comments: [appComment({ ready: false })],
    graphql: threadsData([thread({
      authors: ['example-reviewer', 'maintainer'],
      bodies: ['Leak on error.', '@example-reviewer please review the new test'],
    })]),
  });
  assert.equal(threadOnly.decision, 'already-off');
  const prWide = await reconcile({
    comments: [
      appComment({ ready: false, body: needsWorkPrWide() }),
      humanIssueComment({ body: '@example-reviewer please review the new test' }),
    ],
  });
  assert.equal(prWide.decision, 'already-off');
});

test('a 403 that refuses to create the label is missing-label; another 403 rejects', async () => {
  const missing = await reconcile({
    addStatus: 403,
    addJson: { message: 'You do not have permission to create labels on this repository' },
  });
  assert.equal(missing.decision, 'missing-label');
  await assert.rejects(() => reconcile({
    addStatus: 403,
    addJson: { message: 'You have exceeded a secondary rate limit.' },
  }), /returned 403/);
});

test('a read that throws after an add removes the label and rejects', async () => {
  const labels = [];
  let pulls = 0;
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => {
      pulls += 1;
      if (pulls >= 3) throw new Error('HTTP 502');
      return pullJson({ labels: [...labels] });
    },
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  await assert.rejects(() => reconcileReadyLabel({
    api, graphql: async () => threadsData([]),
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    log() {}, warn() {},
  }), /HTTP 502/);
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(labels, []);
});

test('an add is removed when the Lambda is about to time out', async () => {
  const headB = 'bbbbbbbbbb0123456789deadbeefcafebabe00000000';
  const labels = [];
  let posted = false;
  const shas = [HEAD, HEAD, headB];
  const api = fakeGitHub({
    [`GET repos/${REPO}/pulls/7`]: () => pullJson({ sha: shas.shift() ?? headB, labels: [...labels] }),
    [`GET repos/${REPO}/issues/7/comments?per_page=100&page=1`]: { status: 200, json: [appComment()] },
    [`POST repos/${REPO}/issues/7/labels`]: () => {
      posted = true;
      labels.push(LABEL);
      return { status: 200, json: {} };
    },
    [`DELETE repos/${REPO}/issues/7/labels/${encodeURIComponent(LABEL)}`]: () => {
      labels.splice(0);
      return { status: 200, json: {} };
    },
  });
  const decision = await reconcileReadyLabel({
    api, graphql: async () => threadsData([]),
    repo: REPO, prNumber: 7, appId: APP_ID, botLogin: BOT, isBot, label: LABEL,
    remainingMs: () => (posted ? 1_000 : 30_000),
    log() {}, warn() {},
  });
  assert.equal(decision, 'stale-head');
  assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(labels, []);
});

test('operational failures reject so Lambda retries; validation errors resolve', async () => {
  const handler = (event) => runReadyLabelHandler(async (e) => {
    if (e.pr_number === 'boom') throw new Error('ServiceUnavailableException');
    return { error: 'invalid pr_number' };
  }, event);
  await assert.rejects(() => handler({ pr_number: 'boom' }), /ServiceUnavailableException/);
  assert.deepEqual(await handler({}), { error: 'invalid pr_number' });
});
