import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeGitHub, fakeStore } from './support/fakes.mjs';

const { loadReceiverConfig } = await import('../src/config.ts');
const { createDeliveryHandler } = await import('../src/delivery.ts');
const { heartbeatRunKey } = await import('../src/review-envelope.ts');

const SECRET = 'webhook-secret';
const BOT = 'example-reviewer[bot]';
const REPO = 'example-org/valkey';
const GLIDE = 'example-org/valkey-glide';

const ENV = {
  REVIEW_ROUTE_MAP_JSON: JSON.stringify({
    [REPO]: { routeId: 'valkey-review', queueUrl: 'q-valkey', reviewerId: 'valkey-review' },
    [GLIDE]: { routeId: 'valkey-glide-review', queueUrl: 'q-glide', reviewerId: 'valkey-glide-review', skipDrafts: true, threadReplyReview: true },
    'example-org/mention-only': { routeId: 'mention-only', queueUrl: 'q-mo', reviewerId: 'valkey-review', mentionOnly: true },
    'example-org/gated': { routeId: 'gated', queueUrl: 'q-gated', reviewerId: 'valkey-review', authorAllowlist: ['Trusted'] },
  }),
  CURATOR_ROUTE_MAP_JSON: JSON.stringify({
    [REPO]: { reviewerId: 'valkey-review' },
    [GLIDE]: { reviewerId: 'valkey-glide-review' },
  }),
  CURATOR_QUEUE_URL: 'q-curator',
  IDEMPOTENCY_TABLE: 'idempotency',
  GITHUB_SECRET_ARN: 'secret',
  BOT_LOGIN: BOT,
  HAIKU_MODEL_ID: 'safety-model',
};

function setup({ env = {}, github = {}, store = fakeStore(), secrets = [SECRET], sendMessage, approve, syncReadyLabel } = {}) {
  const sent = [];
  const logs = [];
  const secretCalls = [];
  const readyLabel = [];
  const api = fakeGitHub(github);
  const handler = createDeliveryHandler(loadReceiverConfig({ ...ENV, ...env }), {
    webhookSecret: async (refresh) => {
      secretCalls.push(refresh);
      return refresh ? secrets.at(-1) : secrets[0];
    },
    store,
    sendMessage: sendMessage ?? (async (queueUrl, body, attributes, options) => {
      sent.push({ queueUrl, body, attributes, ...(options ? { options } : {}) });
    }),
    github: async () => api,
    approveInstruction: approve ?? (async () => ({ allow: true, reason: '' })),
    log: (line) => logs.push(line),
    ...(syncReadyLabel !== undefined ? { syncReadyLabel } : {
      syncReadyLabel: async (args) => { readyLabel.push(args); },
    }),
  });
  return { handler, sent, logs, secretCalls, store, api, readyLabel };
}

function delivery(eventType, payload, { secret = SECRET, base64 = false } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return {
    headers: { 'X-GitHub-Event': eventType, 'X-Hub-Signature-256': signature },
    body: base64 ? raw.toString('base64') : raw.toString('utf8'),
    isBase64Encoded: base64,
  };
}

function prEvent(action, pr = {}, repo = REPO) {
  return {
    action,
    installation: { id: 42 },
    repository: { full_name: repo },
    sender: { login: 'author' },
    pull_request: { number: 7, user: { login: 'author', type: 'User' }, head: { sha: 'abc123' }, draft: false, ...pr },
  };
}

const body = (resp) => JSON.parse(resp.body);

test('a bad signature is rejected and nothing from the payload is logged', async () => {
  const { handler, logs, secretCalls, sent } = setup();
  const resp = await handler(delivery('pull_request', prEvent('opened'), { secret: 'wrong' }));
  assert.equal(resp.statusCode, 401);
  assert.deepEqual(logs, ['[delivery] status=401 decision=err:bad-signature']);
  assert.deepEqual(secretCalls, [false, true], 'refetched once in case of rotation');
  assert.equal(sent.length, 0);
});

test('a missing signature is rejected without fetching the secret', async () => {
  const { handler, secretCalls } = setup();
  const event = delivery('ping', {});
  delete event.headers['X-Hub-Signature-256'];
  assert.equal((await handler(event)).statusCode, 401);
  assert.deepEqual(secretCalls, []);
});

test('a delivery signed with a rotated secret verifies after one refetch', async () => {
  const { handler, sent } = setup({ secrets: ['old-secret', 'new-secret'] });
  const resp = await handler(delivery('pull_request', prEvent('opened'), { secret: 'new-secret' }));
  assert.equal(resp.statusCode, 200);
  assert.equal(sent.length, 1);
});

test('a base64 body is verified and parsed', async () => {
  const { handler, sent } = setup();
  const resp = await handler(delivery('pull_request', prEvent('opened'), { base64: true }));
  assert.equal(resp.statusCode, 200);
  assert.equal(sent.length, 1);
});

test('a verified delivery logs its metadata and decision', async () => {
  const { handler, logs } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  assert.deepEqual(logs, [
    `[auto-review] route=valkey-review repo=${REPO} pr=7 round=1/3 queued`,
    `[delivery] event=pull_request action=opened repo=${REPO} actor=author status=200 decision=enqueued:${REPO}#7#abc123`,
  ]);
});

test('ping and unhandled events are acknowledged', async () => {
  const { handler } = setup();
  assert.deepEqual(body(await handler(delivery('ping', { zen: 'hi' }))), { ok: true, ping: true });
  assert.equal(body(await handler(delivery('push', { installation: { id: 1 } }))).skipped, 'event=push');
});

test('a delivery without an installation is rejected unless INSTALLATION_ID is set', async () => {
  const payload = prEvent('opened');
  delete payload.installation;
  const a = setup();
  assert.equal((await a.handler(delivery('pull_request', payload))).statusCode, 400);
  const b = setup({ env: { INSTALLATION_ID: '99' } });
  await b.handler(delivery('pull_request', payload));
  assert.equal(b.sent[0].body.installation_id, 99);
});

test('an opened PR is queued on its route with the runtime payload', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  assert.deepEqual(sent, [{
    queueUrl: 'q-valkey',
    body: { repo: REPO, pr_number: 7, installation_id: 42, head_sha: 'abc123', pending_marker: 'pending-1', trigger: 'opened', skip_drafts: false },
    attributes: { repo: REPO, pr_number: 7, action: 'opened' },
  }]);
  assert.equal(store.slotsTaken, 1);
  assert.equal(store.pending.get(`${REPO}#7`), 'pending-1', 'it holds the marker until the worker starts it');
});

test('a duplicate delivery is skipped and does not use budget', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  assert.equal(body(await handler(delivery('pull_request', prEvent('opened')))).skipped, 'duplicate');
  assert.equal(sent.length, 1);
  assert.equal(store.slotsTaken, 1);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1);
});

test('the first automatic review counts toward the pull request\'s cap', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened', { number: 1 })));
  await handler(delivery('pull_request', prEvent('ready_for_review', { number: 2 }, GLIDE)));
  await handler(delivery('pull_request', prEvent('reopened', { number: 3, head: { sha: 'fff' } })));
  assert.equal(sent.length, 3);
  assert.equal(store.autoReviews.get(`${REPO}#1`), 1);
  assert.equal(store.autoReviews.get(`${GLIDE}#2`), 1);
  assert.equal(store.autoReviews.get(`${REPO}#3`), 1);
});

test('at the cap an automatic review is skipped, logged, and gives back what it took', async () => {
  const { handler, sent, store, logs } = setup({ env: { MAX_AUTOMATIC_REVIEWS_PER_PR: '2' } });
  store.autoReviews.set(`${REPO}#7`, 2);
  const resp = await handler(delivery('pull_request', prEvent('reopened')));
  assert.equal(body(resp).skipped, 'auto-review-cap');
  assert.equal(sent.length, 0);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 2);
  assert.deepEqual(store.released, [`${REPO}#7#abc123#reopened`]);
  assert.equal(store.slotsTaken, 0, 'a capped review uses no budget');
  assert.equal(store.pending.size, 0, 'it gives back the marker');
  assert.deepEqual(logs, [
    `[auto-review] route=valkey-review repo=${REPO} pr=7 cap=2 reached; skipped`,
    `[delivery] event=pull_request action=reopened repo=${REPO} actor=author status=200 decision=skipped:auto-review-cap`,
  ]);
});

test('the cap counts per pull request, whatever the repository name\'s case', async () => {
  const { handler, sent, store } = setup({ env: { MAX_AUTOMATIC_REVIEWS_PER_PR: '1' } });
  store.autoReviews.set(`${REPO}#7`, 1);
  const upper = prEvent('opened', {}, 'Example-Org/Valkey');
  assert.equal(body(await handler(delivery('pull_request', upper))).skipped, 'auto-review-cap');
  await handler(delivery('pull_request', prEvent('opened', { number: 8 })));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.pr_number, 8);
});

test('route gates: unrouted, mention-only, bot author, author allowlist, other actions', async () => {
  const { handler, sent } = setup();
  const skipped = async (payload) => body(await handler(delivery('pull_request', payload))).skipped;
  assert.equal(await skipped(prEvent('opened', {}, 'someone/else')), 'unrouted-repo=someone/else');
  assert.equal(await skipped(prEvent('opened', {}, 'example-org/mention-only')), 'mention-only-route=mention-only');
  assert.equal(await skipped(prEvent('opened', { user: { login: 'dependabot[bot]', type: 'Bot' } })), 'bot-author=dependabot[bot]');
  assert.equal(await skipped(prEvent('opened', {}, 'example-org/gated')), 'author-not-allowed=author');
  assert.equal(await skipped(prEvent('edited')), 'action=edited');
  assert.equal(await skipped(prEvent('closed')), 'action=closed');
  assert.equal(sent.length, 0);
  await handler(delivery('pull_request', prEvent('opened', { user: { login: 'trusted' } }, 'example-org/gated')));
  assert.equal(sent.length, 1);
});

test('drafts: skipDrafts routes wait for ready_for_review, others ignore it', async () => {
  const { handler, sent } = setup();
  assert.equal(body(await handler(delivery('pull_request', prEvent('opened', { draft: true }, GLIDE)))).skipped, 'draft');
  assert.equal(body(await handler(delivery('pull_request', prEvent('ready_for_review')))).skipped, 'action=ready_for_review');
  await handler(delivery('pull_request', prEvent('opened', { draft: true })));
  assert.equal(sent.length, 1, 'a draft reviews on a route without skipDrafts');
});

test('ready_for_review gets its own key and heartbeat nonce', async () => {
  const { handler, sent, store } = setup();
  store.keys.set(`${GLIDE}#7#abc123`, {});
  await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.run_nonce, 'ready');
  assert.ok(store.keys.has(`${GLIDE}#7#abc123#ready`));
});

test('a reopen has its own key and heartbeat nonce, so it reviews a head whose opened review was skipped', async () => {
  // The opened review started once the pull request was closed, so the
  // runtime skipped it and recorded its run completed; the pull request
  // is then reopened at the same head. The receiver cannot tell that
  // from a review that ran: a reopen at a head that was already reviewed
  // is reviewed again too, and uses a round.
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  await store.clearReviewPending(REPO, 7, 'pending-1');
  const resp = await handler(delivery('pull_request', prEvent('reopened')));
  assert.equal(body(resp).enqueued, `${REPO}#7#abc123#reopened`, 'not a duplicate of the opened review');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.run_nonce, undefined);
  assert.equal(sent[1].body.run_nonce, 'reopened');
  assert.equal(sent[1].body.trigger, 'reopened');
  assert.notEqual(heartbeatRunKey(sent[1].body), heartbeatRunKey(sent[0].body), 'the worker reads its own heartbeat');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 2, 'it uses a round');

  await store.clearReviewPending(REPO, 7, 'pending-2');
  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened')))).skipped, 'duplicate', 'a reopen is still reviewed once per head');
  assert.equal(body(await handler(delivery('pull_request', prEvent('opened')))).skipped, 'duplicate');
  assert.equal(sent.length, 2);
});

test('a draft marked ready again reviews when its waiting ready review was skipped', async () => {
  // On a skipDrafts route the ready review waits (behind another run,
  // say), the pull request goes back to draft, and the review then
  // starts: the runtime skips it. Marking the pull request ready again
  // at the same head must queue a review, not be dropped as a duplicate.
  const { handler, sent, store, logs } = setup();
  await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  const converted = await handler(delivery('pull_request', prEvent('converted_to_draft', { draft: true }, GLIDE)));
  assert.equal(converted.statusCode, 200);
  assert.equal(body(converted).skipped, 'action=converted_to_draft');
  assert.deepEqual(store.released, [`${GLIDE}#7#abc123#ready`]);
  assert.equal(logs.at(-2), `[auto-review] route=valkey-glide-review repo=${GLIDE} pr=7 head=abc123 converted_to_draft while a review waits; released ${GLIDE}#7#abc123#ready and gave back its round in case that review is skipped`);
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 0, 'the review that is skipped gives back its round');

  await store.clearReviewPending(GLIDE, 7, 'pending-1');
  const again = await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  assert.equal(body(again).enqueued, `${GLIDE}#7#abc123#ready`, 'not a duplicate of the skipped review');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.run_nonce, 'ready');
  assert.equal(sent[1].body.pending_marker, 'pending-2');
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 1, 'it uses a round');
  assert.equal(body(await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)))).skipped, 'duplicate', 'a redelivery is still a duplicate');
});

test('a reopen reviews when the review of the reopen before it was skipped', async () => {
  // The reopened pull request's review waits, the pull request is closed
  // again, and the review then starts: the runtime skips it.
  const { handler, sent, store, logs } = setup();
  await handler(delivery('pull_request', prEvent('reopened')));
  assert.equal(body(await handler(delivery('pull_request', prEvent('closed')))).skipped, 'action=closed');
  assert.deepEqual(store.released, [`${REPO}#7#abc123#reopened`]);
  assert.equal(logs.at(-2), `[auto-review] route=valkey-review repo=${REPO} pr=7 head=abc123 closed while a review waits; released ${REPO}#7#abc123#reopened and gave back its round in case that review is skipped`);

  await store.clearReviewPending(REPO, 7, 'pending-1');
  const resp = await handler(delivery('pull_request', prEvent('reopened')));
  assert.equal(body(resp).enqueued, `${REPO}#7#abc123#reopened`, 'not a duplicate of the skipped review');
  assert.equal(sent.length, 2);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'only the review that runs uses a round');
});

test('a review the runtime skips because the pull request left does not use up the cap', async () => {
  // Cap 3. The review of new commits waits, the pull request goes back to
  // draft, and the review then starts and is skipped. Marked ready, the
  // pull request still has the rounds for its later heads.
  const { handler, sent, store } = setup({ env: { MAX_AUTOMATIC_REVIEWS_PER_PR: '3' } });
  const event = (action, sha, pr = {}) => delivery('pull_request', prEvent(action, { head: { sha }, ...pr }, GLIDE));
  await handler(event('opened', 'a1'));
  await store.clearReviewPending(GLIDE, 7, 'pending-1');
  await handler(event('synchronize', 'a2'));
  await handler(event('converted_to_draft', 'a2', { draft: true }));
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 1);
  await store.clearReviewPending(GLIDE, 7, 'pending-2');

  await handler(event('ready_for_review', 'a2'));
  await store.clearReviewPending(GLIDE, 7, 'pending-3');
  assert.equal(body(await handler(event('synchronize', 'a3'))).enqueued, `${GLIDE}#7#a3#push`, 'the final head is reviewed');
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 3);
  await store.clearReviewPending(GLIDE, 7, 'pending-4');
  assert.equal(body(await handler(event('synchronize', 'a4'))).skipped, 'auto-review-cap');
  assert.equal(sent.length, 4);
});

test('a waiting review gives back its round once, however often the pull request leaves, and takes it again when it comes back', async () => {
  const { handler, store, logs } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  await handler(delivery('pull_request', prEvent('closed')));
  await handler(delivery('pull_request', prEvent('closed')));
  assert.equal(store.autoReviews.get(`${REPO}#7`), 0, 'a redelivered close gives nothing more back');
  assert.match(logs.at(-2), /closed while a review waits; released \S+ in case that review is skipped$/);

  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened')))).skipped, 'auto-review-pending');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'the review runs after all');
  assert.ok(logs.includes(`[auto-review] route=valkey-review repo=${REPO} pr=7 round=1/3 taken again by the waiting review`), logs.join('\n'));
  assert.equal(body(await handler(delivery('pull_request', prEvent('synchronize', { head: { sha: 'abc124' } })))).skipped, 'auto-review-pending');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'only once');

  await handler(delivery('pull_request', prEvent('closed', { head: { sha: 'abc124' } })));
  assert.equal(store.autoReviews.get(`${REPO}#7`), 0, 'left again');
  assert.equal(store.returned.length, 2);
});

test('a store error while giving back or taking again a waiting review\'s round is logged and the delivery still succeeds', async () => {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    const store = fakeStore();
    const failing = async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); };
    const { handler, logs } = setup({ store });
    await handler(delivery('pull_request', prEvent('opened')));
    store.markRoundGivenBack = failing;
    const closed = await handler(delivery('pull_request', prEvent('closed')));
    assert.equal(body(closed).skipped, 'action=closed');
    assert.equal(errors[0], `[store] could not give back the round of the review of ${REPO}#7 that waits after closed; if that review is skipped, it still uses its round`);
    assert.match(logs.at(-2), /released \S+ in case that review is skipped$/);
    assert.equal(store.autoReviews.get(`${REPO}#7`), 1);

    store.clearRoundGivenBack = failing;
    const reopened = await handler(delivery('pull_request', prEvent('reopened')));
    assert.equal(body(reopened).skipped, 'auto-review-pending');
    assert.equal(errors[1], `[store] could not take the round of the waiting review of ${REPO}#7 again; the pull request has one more`);
  } finally {
    console.error = original;
  }
});

test('back before the waiting review starts, a reopen or ready_for_review joins it and uses no round', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  await handler(delivery('pull_request', prEvent('closed')));
  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened')))).skipped, 'auto-review-pending');
  await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  await handler(delivery('pull_request', prEvent('converted_to_draft', { draft: true }, GLIDE)));
  assert.equal(body(await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)))).skipped, 'auto-review-pending');
  assert.equal(sent.length, 2);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1);
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 1);
});

test('with no review waiting, closing or going back to draft keeps the key of a head already reviewed', async () => {
  // The worker had started the review before the event: the review read
  // the pull request as it was then, and covered the head. Closing and
  // reopening (to run CI again, say), or a draft marked ready again,
  // does not review that head again.
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  await store.clearReviewPending(GLIDE, 7, 'pending-1');
  await handler(delivery('pull_request', prEvent('converted_to_draft', { draft: true }, GLIDE)));
  assert.equal(body(await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)))).skipped, 'duplicate');

  await handler(delivery('pull_request', prEvent('reopened')));
  await store.clearReviewPending(REPO, 7, 'pending-2');
  await handler(delivery('pull_request', prEvent('closed')));
  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened')))).skipped, 'duplicate');
  assert.deepEqual(store.released, []);
  assert.equal(sent.length, 2);
});

test('closing or going back to draft releases nothing for merges, bots, other routes, or drafts a route reviews', async () => {
  const store = fakeStore();
  const reads = [];
  store.hasPendingReview = async (repo, prNumber) => {
    reads.push(`${repo}#${prNumber}`);
    return true;
  };
  const { handler, sent } = setup({ store });
  const left = async (payload) => body(await handler(delivery('pull_request', payload))).skipped;
  assert.equal(await left(prEvent('converted_to_draft', { draft: true })), 'action=converted_to_draft', 'a route without skipDrafts');
  assert.equal(await left(prEvent('closed', { merged: true })), 'action=closed');
  assert.equal(await left(prEvent('closed', { user: { login: 'dependabot[bot]', type: 'Bot' } })), 'action=closed');
  assert.equal(await left(prEvent('closed', {}, 'someone/else')), 'action=closed');
  assert.equal(await left(prEvent('closed', {}, 'example-org/mention-only')), 'action=closed');
  assert.equal(await left(prEvent('closed', { head: {} })), 'action=closed');
  assert.deepEqual(reads, []);
  assert.deepEqual(store.released, []);

  assert.equal(await left(prEvent('closed')), 'action=closed');
  assert.equal(await left(prEvent('converted_to_draft', { draft: true }, GLIDE)), 'action=converted_to_draft');
  assert.deepEqual(reads, [`${REPO}#7`, `${GLIDE}#7`]);
  assert.deepEqual(store.released, [`${REPO}#7#abc123#reopened`, `${GLIDE}#7#abc123#ready`]);
  assert.equal(sent.length, 0, 'these events never review');
});

test('a store error while closing is logged and the delivery still succeeds', async () => {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    const store = fakeStore();
    store.hasPendingReview = async () => {
      throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    };
    const { handler } = setup({ store });
    const resp = await handler(delivery('pull_request', prEvent('closed')));
    assert.equal(resp.statusCode, 200);
    assert.equal(body(resp).skipped, 'action=closed');
    assert.equal(errors[0], `[store] could not release ${REPO}#7#abc123#reopened after closed; if the waiting review is skipped, a reopened event at this head is dropped as a duplicate`);
  } finally {
    console.error = original;
  }
});

const push = (sha, pr = {}, repo = REPO) => prEvent('synchronize', { head: { sha }, ...pr }, repo);

test('new commits start a delayed review that holds the pull request\'s pending marker', async () => {
  const { handler, sent, store, logs } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  await store.clearReviewPending(REPO, 7, 'pending-1');
  const resp = await handler(delivery('pull_request', push('bbb')));
  assert.equal(body(resp).enqueued, `${REPO}#7#bbb#push`);
  assert.deepEqual(sent[1], {
    queueUrl: 'q-valkey',
    body: {
      repo: REPO, pr_number: 7, installation_id: 42, head_sha: 'bbb', run_nonce: 'push', pending_marker: 'pending-2', trigger: 'push', skip_drafts: false,
    },
    attributes: { repo: REPO, pr_number: 7, action: 'synchronize' },
    options: { delaySeconds: 300 },
  });
  assert.equal(store.pending.get(`${REPO}#7`), 'pending-2');
  assert.deepEqual(store.pendingDelays, [0, 300], 'the marker outlives the delay');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 2);
  assert.equal(store.slotsTaken, 2, 'it takes a budget slot like any automatic review');
  assert.equal(logs.at(-2), `[auto-review] route=valkey-review repo=${REPO} pr=7 round=2/3 queued delay=300s`);
});

test('a review of new commits has its own key and heartbeat nonce, so a reopen at that head still reviews', async () => {
  // The push review ran on a closed pull request and was skipped; the
  // pull request is then reopened at the same head.
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', push('bbb')));
  await store.clearReviewPending(REPO, 7, 'pending-1');
  const resp = await handler(delivery('pull_request', prEvent('reopened', { head: { sha: 'bbb' } })));
  assert.equal(body(resp).enqueued, `${REPO}#7#bbb#reopened`, 'not a duplicate of the review of new commits');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.run_nonce, 'push');
  assert.equal(sent[1].body.run_nonce, 'reopened');
  assert.notEqual(heartbeatRunKey(sent[1].body), heartbeatRunKey(sent[0].body), 'the worker reads its own heartbeat');
  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened', { head: { sha: 'bbb' } })))).skipped, 'duplicate');
});

test('pushes while a review of new commits waits are covered by it', async () => {
  const { handler, sent, store, logs } = setup();
  await handler(delivery('pull_request', push('bbb')));
  const resp = await handler(delivery('pull_request', push('ccc')));
  assert.equal(body(resp).skipped, 'auto-review-pending');
  assert.deepEqual(logs.slice(-2), [
    `[auto-review] route=valkey-review repo=${REPO} pr=7 head=ccc joins the waiting review; skipped`,
    `[delivery] event=pull_request action=synchronize repo=${REPO} actor=author status=200 decision=skipped:auto-review-pending`,
  ]);
  assert.equal(sent.length, 1);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'no round used');
  assert.equal(store.slotsTaken, 1, 'no budget used');
  assert.deepEqual(store.released, [`${REPO}#7#ccc#push`], 'the key is released in case the waiting review is not queued after all');
  assert.equal(store.keys.has(`${REPO}#7#ccc#push`), false);
  assert.equal(store.pending.get(`${REPO}#7`), 'pending-1');
  assert.equal(body(await handler(delivery('pull_request', push('ccc')))).skipped, 'auto-review-pending', 'a redelivery joins again');
});

test('a push skipped behind a review that then fails to queue is reviewed on redelivery', async () => {
  // The first push holds the marker while its send is still in flight;
  // the second push arrives in that window and is skipped.
  let failSend;
  const sent = [];
  const { handler, store } = setup({
    sendMessage: async (queueUrl, b, attributes, options) => {
      if (b.head_sha === 'bbb') {
        await new Promise((resolve) => { failSend = resolve; });
        throw new Error('queue unavailable');
      }
      sent.push({ b, options });
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    const first = handler(delivery('pull_request', push('bbb')));
    while (!failSend) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(body(await handler(delivery('pull_request', push('ccc')))).skipped, 'auto-review-pending');
    failSend();
    assert.equal((await first).statusCode, 500);
  } finally {
    console.error = original;
  }
  assert.equal(store.pending.size, 0, 'the failed review gave its marker back');

  const resp = await handler(delivery('pull_request', push('ccc')));
  assert.equal(body(resp).enqueued, `${REPO}#7#ccc#push`, 'not dropped as a duplicate');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].b.head_sha, 'ccc');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1);
});

test('once the worker starts the waiting review, the next push starts the next round, up to the cap', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  assert.equal(await store.clearReviewPending(REPO, 7, 'pending-1'), true);
  await handler(delivery('pull_request', push('bbb')));
  assert.equal(await store.clearReviewPending(REPO, 7, 'pending-2'), true);
  await handler(delivery('pull_request', push('ccc')));
  assert.equal(sent.length, 3);
  assert.equal(sent[2].body.pending_marker, 'pending-3');
  assert.equal(store.autoReviews.get(`${REPO}#7`), 3);

  await store.clearReviewPending(REPO, 7, 'pending-3');
  const resp = await handler(delivery('pull_request', push('ddd')));
  assert.equal(body(resp).skipped, 'auto-review-cap');
  assert.equal(sent.length, 3);
  assert.equal(store.pending.size, 0, 'the capped push leaves no marker');
  assert.deepEqual(store.released, [`${REPO}#7#ddd#push`]);
  assert.equal(store.slotsTaken, 3);
});

test('new commits pass the same gates as an opened pull request', async () => {
  const { handler, sent, store } = setup();
  const skipped = async (payload) => body(await handler(delivery('pull_request', payload))).skipped;
  assert.equal(await skipped(push('b1', {}, 'someone/else')), 'unrouted-repo=someone/else');
  assert.equal(await skipped(push('b2', {}, 'example-org/mention-only')), 'mention-only-route=mention-only');
  assert.equal(await skipped(push('b3', { user: { login: 'dependabot[bot]', type: 'Bot' } })), 'bot-author=dependabot[bot]');
  assert.equal(await skipped(push('b4', {}, 'example-org/gated')), 'author-not-allowed=author');
  assert.equal(await skipped(push('b5', { draft: true }, GLIDE)), 'draft');
  assert.equal(sent.length, 0);
  assert.equal(store.pending.size, 0);

  await handler(delivery('pull_request', push('b6', { draft: true })));
  assert.equal(sent.length, 1, 'a push to a draft reviews on a route without skipDrafts');
  await store.clearReviewPending(REPO, 7, 'pending-1');
  assert.equal(await skipped(push('b6')), 'duplicate', 'one review per head SHA');
});

test('a push to a pull request that is not a draft reviews on a skipDrafts route', async () => {
  const { handler, sent } = setup();
  const resp = await handler(delivery('pull_request', push('b7', { draft: false }, GLIDE)));
  assert.equal(body(resp).enqueued, `${GLIDE}#7#b7#push`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueUrl, 'q-glide');
  assert.deepEqual(sent[0].options, { delaySeconds: 300 });
  assert.equal(sent[0].body.trigger, 'push');
  assert.equal(sent[0].body.skip_drafts, true, 'the runtime skips the run if the pull request is a draft by then');
});

test('over budget, a review of new commits gives back its marker, its round and its key', async () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    const { handler, sent, store } = setup({ env: { DAILY_REVIEW_BUDGET: '1' } });
    await handler(delivery('pull_request', prEvent('opened', { number: 1 })));
    const resp = await handler(delivery('pull_request', push('bbb')));
    assert.equal(body(resp).skipped, 'budget-exhausted=valkey-review');
    assert.equal(sent.length, 1);
    assert.equal(store.pending.has(`${REPO}#7`), false);
    assert.equal(store.autoReviews.get(`${REPO}#7`), 0);
    assert.deepEqual(store.released, [`${REPO}#7#bbb#push`]);
  } finally {
    console.warn = original;
  }
});

test('a failed send of a review of new commits gives back its marker, its round and its key', async () => {
  let fail = true;
  const sent = [];
  const { handler, store } = setup({
    sendMessage: async (queueUrl, b, attributes, options) => {
      if (fail) throw new Error('queue unavailable');
      sent.push({ b, options });
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handler(delivery('pull_request', push('bbb')))).statusCode, 500);
  } finally {
    console.error = original;
  }
  assert.equal(store.pending.size, 0);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 0);
  assert.deepEqual(store.released, [`${REPO}#7#bbb#push`]);

  fail = false;
  assert.equal((await handler(delivery('pull_request', push('bbb')))).statusCode, 200, 'a redelivery is processed');
  assert.equal(sent[0].b.pending_marker, 'pending-2');
  assert.deepEqual(sent[0].options, { delaySeconds: 300 });
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1);
});

test('PUSH_REVIEW_DELAY_SECONDS sets the delay; 0 still holds the marker until the run starts', async () => {
  const { handler, sent, store } = setup({ env: { PUSH_REVIEW_DELAY_SECONDS: '0' } });
  await handler(delivery('pull_request', push('bbb')));
  assert.deepEqual(sent[0].options, { delaySeconds: 0 });
  assert.equal(body(await handler(delivery('pull_request', push('ccc')))).skipped, 'auto-review-pending');
  assert.equal(store.pending.get(`${REPO}#7`), 'pending-1');
});

test('a reopen or a draft marked ready joins a waiting review of new commits', async () => {
  const { handler, sent, store, logs } = setup();
  await handler(delivery('pull_request', push('bbb')));
  await handler(delivery('pull_request', push('bbb', {}, GLIDE)));
  const reopened = await handler(delivery('pull_request', prEvent('reopened', { head: { sha: 'ccc' } })));
  assert.equal(body(reopened).skipped, 'auto-review-pending');
  assert.equal(logs.at(-2), `[auto-review] route=valkey-review repo=${REPO} pr=7 head=ccc joins the waiting review; skipped`);
  const ready = await handler(delivery('pull_request', prEvent('ready_for_review', { head: { sha: 'ccc' } }, GLIDE)));
  assert.equal(body(ready).skipped, 'auto-review-pending');

  assert.equal(sent.length, 2);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'no round used');
  assert.equal(store.autoReviews.get(`${GLIDE}#7`), 1);
  assert.equal(store.slotsTaken, 2, 'no budget used');
  assert.deepEqual(store.released, [`${REPO}#7#ccc#reopened`, `${GLIDE}#7#ccc#ready`]);
  assert.equal(store.pending.get(`${REPO}#7`), 'pending-1', 'the marker stays with the waiting review');
});

test('reviews that are not from new commits hold the marker and name their trigger, with no delay', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('opened')));
  await handler(delivery('pull_request', prEvent('reopened', { number: 8 })));
  await handler(delivery('pull_request', prEvent('ready_for_review', {}, GLIDE)));
  await handler(delivery('pull_request', prEvent('opened', { number: 9 }, GLIDE)));
  assert.deepEqual(sent.map((s) => [s.body.pending_marker, s.body.trigger, s.body.skip_drafts, s.options]), [
    ['pending-1', 'opened', false, undefined],
    ['pending-2', 'reopened', false, undefined],
    ['pending-3', 'ready_for_review', true, undefined],
    ['pending-4', 'opened', true, undefined],
  ], 'the runtime skips the run if the pull request is closed, or a draft on a skipDrafts route, by then');
  assert.deepEqual(store.pendingDelays, [0, 0, 0, 0], 'their markers expire an hour after they are taken');
});

test('a push or a reopen while a reopened pull request\'s review waits joins it', async () => {
  const { handler, sent, store } = setup();
  await handler(delivery('pull_request', prEvent('reopened')));
  assert.equal(body(await handler(delivery('pull_request', push('bbb')))).skipped, 'auto-review-pending');
  assert.equal(body(await handler(delivery('pull_request', prEvent('reopened', { head: { sha: 'ccc' } })))).skipped, 'auto-review-pending');
  assert.equal(sent.length, 1);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1, 'no round used');
  assert.equal(store.slotsTaken, 1, 'no budget used');
  assert.deepEqual(store.released, [`${REPO}#7#bbb#push`, `${REPO}#7#ccc#reopened`]);

  await store.clearReviewPending(REPO, 7, 'pending-1');
  await handler(delivery('pull_request', push('bbb')));
  assert.equal(sent.length, 2, 'after the worker starts that review, a push queues the next round');
  assert.equal(sent[1].body.pending_marker, 'pending-2');
});

test('over budget: the review is skipped, logged, and its key released', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const { handler, sent, store } = setup({ env: { DAILY_REVIEW_BUDGET: '1' } });
    await handler(delivery('pull_request', prEvent('opened', { number: 1 })));
    const resp = await handler(delivery('pull_request', prEvent('opened', { number: 2 })));
    assert.equal(body(resp).skipped, 'budget-exhausted=valkey-review');
    assert.equal(sent.length, 1);
    assert.deepEqual(store.released, [`${REPO}#2#abc123`]);
    assert.equal(store.autoReviews.get(`${REPO}#2`), 0, 'the pull request keeps its automatic review');
    assert.match(warnings[0], /\[budget\] route=valkey-review daily budget of 1 reviews used up; skipped example-org\/valkey#2/);
  } finally {
    console.warn = original;
  }
});

test('@mention summons are not budgeted', async () => {
  const { handler, sent, store } = setup({
    env: { DAILY_REVIEW_BUDGET: '0' },
    github: {
      [`GET repos/${REPO}/collaborators/maintainer/permission`]: { status: 200, json: { permission: 'write' } },
      [`GET repos/${REPO}/pulls/7`]: { status: 200, json: { state: 'open', head: { sha: 'abc123' } } },
      [`POST repos/${REPO}/issues/7/comments`]: { status: 201, json: { id: 5 } },
    },
  });
  const resp = await handler(delivery('issue_comment', {
    action: 'created',
    installation: { id: 42 },
    repository: { full_name: REPO },
    sender: { login: 'maintainer' },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 11, body: '@example-reviewer review please', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.equal(body(resp).enqueued, 'mention#issue_comment-11');
  assert.equal(sent[0].queueUrl, 'q-valkey');
  assert.equal(sent[0].attributes.action, 'mention');
  assert.equal(store.slotsTaken, 0);
});

test('@mention summons run past the automatic review cap and do not count toward it', async () => {
  const { handler, sent, store } = setup({
    github: {
      [`GET repos/${REPO}/collaborators/maintainer/permission`]: { status: 200, json: { permission: 'write' } },
      [`GET repos/${REPO}/pulls/7`]: { status: 200, json: { state: 'open', head: { sha: 'abc123' } } },
      [`POST repos/${REPO}/issues/7/comments`]: { status: 201, json: { id: 5 } },
    },
  });
  store.autoReviews.set(`${REPO}#7`, 3);
  const resp = await handler(delivery('issue_comment', {
    action: 'created',
    installation: { id: 42 },
    repository: { full_name: REPO },
    sender: { login: 'maintainer' },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 11, body: '@example-reviewer review please', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.equal(body(resp).enqueued, 'mention#issue_comment-11');
  assert.equal(sent.length, 1);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 3);
});

test('a failed enqueue releases the key and returns 500 so a redelivery works', async () => {
  let fail = true;
  const sent = [];
  const { handler, store } = setup({
    sendMessage: async (queueUrl, b) => {
      if (fail) throw new Error('queue unavailable');
      sent.push(b);
    },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const first = await handler(delivery('pull_request', prEvent('opened')));
    assert.equal(first.statusCode, 500);
    assert.deepEqual(body(first), { error: 'internal' });
    assert.deepEqual(store.released, [`${REPO}#7#abc123`]);
    assert.equal(store.autoReviews.get(`${REPO}#7`), 0, 'the automatic review is given back');
    assert.equal(store.slotsTaken, 1, 'the budget slot is not');
  } finally {
    console.error = original;
  }
  fail = false;
  const second = await handler(delivery('pull_request', prEvent('opened')));
  assert.equal(second.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 1);
});

test('a store failure after the claim gives back the key and the automatic review', async () => {
  const store = fakeStore();
  store.takeReviewSlot = async () => { throw new Error('throttled'); };
  const { handler, sent } = setup({ store });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handler(delivery('pull_request', prEvent('opened')))).statusCode, 500);
  } finally {
    console.error = original;
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(store.released, [`${REPO}#7#abc123`]);
  assert.equal(store.autoReviews.get(`${REPO}#7`), 0);
});

function reviewReply(comment = {}, repo = REPO) {
  return {
    action: 'created',
    installation: { id: 42 },
    repository: { full_name: repo },
    sender: { login: comment.user?.login ?? 'maintainer' },
    pull_request: { number: 7, user: { login: 'author' } },
    comment: {
      id: 202, body: 'This is a false positive: the caller holds the lock here.', user: { login: 'maintainer', type: 'User' },
      author_association: 'MEMBER', path: 'src/server.c', line: 40, in_reply_to_id: 150, ...comment,
    },
  };
}

const parentBy = (login) => ({
  [`GET repos/${REPO}/pulls/comments/150`]: {
    status: 200,
    json: { body: 'Use-after-free on the error path.', user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, path: 'src/server.c', line: 40 },
  },
});

test('a maintainer reply in a bot thread reaches the curator with the bot comment', async () => {
  const { handler, sent } = setup({ github: parentBy(BOT) });
  const resp = await handler(delivery('pull_request_review_comment', reviewReply()));
  assert.equal(body(resp).enqueued, 'curator#rc-202');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueUrl, 'q-curator');
  assert.deepEqual(sent[0].body, {
    reviewer_id: 'valkey-review',
    feedback_id: 'rc-202',
    kind: 'review_comment_reply',
    human_body: 'This is a false positive: the caller holds the lock here.',
    actor: 'maintainer',
    actor_association: 'MEMBER',
    repo: REPO,
    pr_number: 7,
    pr_author: 'author',
    bot_comment: { body: 'Use-after-free on the error path.', path: 'src/server.c', line: 40 },
    installation_id: 42,
  });
  assert.deepEqual(sent[0].attributes, { repo: REPO, reviewer_id: 'valkey-review', feedback_id: 'rc-202', kind: 'review_comment_reply' });
});

test('a reply in another bot\'s thread reaches the curator without that bot\'s text', async () => {
  const { handler, sent } = setup({ github: parentBy('other-reviewer[bot]') });
  await handler(delivery('pull_request_review_comment', reviewReply()));
  assert.equal(sent[0].body.bot_comment.body, '');
});

test('the PR author replying outside a bot thread is dropped', async () => {
  const { handler, sent } = setup({ github: parentBy('maintainer') });
  const resp = await handler(delivery('pull_request_review_comment', reviewReply({ user: { login: 'author', type: 'User' } })));
  assert.equal(body(resp).skipped, 'noise:author-reply-to-non-bot');
  assert.equal(sent.length, 0);
});

test('if the parent lookup fails the reply still reaches the curator', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { handler, sent } = setup({ github: { [`GET repos/${REPO}/pulls/comments/150`]: () => { throw new Error('timeout'); } } });
    await handler(delivery('pull_request_review_comment', reviewReply()));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.bot_comment.body, '');
    assert.match(warnings[0], /could not read comment 150/);
  } finally {
    console.warn = original;
  }
});

test('feedback from outsiders, bots, edits and noise never reaches the curator', async () => {
  const { handler, sent } = setup({ github: parentBy(BOT) });
  const skipped = async (eventType, payload) => body(await handler(delivery(eventType, payload))).skipped;
  assert.equal(await skipped('pull_request_review_comment', reviewReply({ author_association: 'CONTRIBUTOR' })), 'not-feedback:association=CONTRIBUTOR');
  assert.equal(await skipped('pull_request_review_comment', reviewReply({ user: { login: 'helper[bot]', type: 'Bot' } })), 'not-feedback:bot-author');
  assert.equal(await skipped('pull_request_review_comment', { ...reviewReply(), action: 'edited' }), 'not-feedback:action=edited');
  assert.equal(await skipped('pull_request_review_comment', reviewReply({ body: 'thanks!' })), 'noise:ack');
  assert.equal(await skipped('pull_request_review_comment', reviewReply({}, 'someone/else')), 'unrouted-repo=someone/else');
  assert.equal(await skipped('issue_comment', {
    action: 'created', installation: { id: 42 }, repository: { full_name: REPO },
    issue: { number: 3, user: { login: 'author' } },
    comment: { id: 9, body: 'A comment on a plain issue that is long enough.', user: { login: 'maintainer' }, author_association: 'OWNER' },
  }), 'not-feedback:not-a-pull-request');
  assert.equal(sent.length, 0);
});

test('feedback is forwarded once', async () => {
  const { handler, sent } = setup({ github: parentBy(BOT) });
  await handler(delivery('pull_request_review_comment', reviewReply()));
  assert.equal(body(await handler(delivery('pull_request_review_comment', reviewReply()))).skipped, 'duplicate-feedback');
  assert.equal(sent.length, 1);
});

test('without a curator queue feedback is skipped', async () => {
  const { handler } = setup({ env: { CURATOR_QUEUE_URL: '' } });
  assert.equal(body(await handler(delivery('pull_request_review_comment', reviewReply()))).skipped, 'curator-queue-not-wired');
});

test('a tagged thread reply on a threadReplyReview route starts a re-review and still teaches the curator', async () => {
  const github = {
    [`GET repos/${GLIDE}/collaborators/maintainer/permission`]: { status: 200, json: { permission: 'write' } },
    [`GET repos/${GLIDE}/pulls/7`]: { status: 200, json: { state: 'open', head: { sha: 'def456' } } },
    [`GET repos/${GLIDE}/pulls/comments/150`]: { status: 200, json: { body: 'Leak.', user: { login: BOT }, path: 'src/lib.rs', line: 9 } },
    [`POST repos/${GLIDE}/issues/7/comments`]: { status: 201, json: { id: 77 } },
  };
  const { handler, sent, logs } = setup({ github });
  const payload = reviewReply({ body: '@example-reviewer fixed in the latest push, please verify' }, GLIDE);
  const resp = await handler(delivery('pull_request_review_comment', payload));
  assert.equal(body(resp).enqueued, 'curator#rc-202');
  assert.deepEqual(sent.map((s) => s.queueUrl), ['q-glide', 'q-curator']);
  assert.match(sent[0].body.instruction, /> Leak\./);
  assert.equal(sent[1].body.bot_comment.body, 'Leak.');
  assert.match(logs[0], /^\[mention\] repo=example-org\/valkey-glide pr=7 decision=enqueued:mention#review_comment-202$/);
});

test('a one-word fix claim in the App\'s thread on a threadReplyReview route starts the run, and the noise filter still keeps it from the curator', async () => {
  const github = {
    [`GET repos/${GLIDE}/collaborators/maintainer/permission`]: { status: 200, json: { permission: 'write' } },
    [`GET repos/${GLIDE}/pulls/7`]: { status: 200, json: { state: 'open', head: { sha: 'def456' } } },
    [`GET repos/${GLIDE}/pulls/comments/150`]: { status: 200, json: { body: 'Leak.', user: { login: BOT }, path: 'src/lib.rs', line: 9 } },
    [`POST repos/${GLIDE}/issues/7/comments`]: { status: 201, json: { id: 77 } },
  };
  for (const word of ['fixed', 'done', 'updated']) {
    const { handler, sent, logs } = setup({ github });
    const resp = await handler(delivery('pull_request_review_comment', reviewReply({ body: `@example-reviewer ${word}` }, GLIDE)));
    assert.equal(body(resp).skipped, 'noise:mention-short', word);
    assert.deepEqual(sent.map((s) => s.queueUrl), ['q-glide']);
    assert.match(sent[0].body.instruction, new RegExp(`\n@maintainer replied: ${word}\n`));
    assert.match(logs[0], /^\[mention\] repo=example-org\/valkey-glide pr=7 decision=enqueued:mention#review_comment-202$/);
  }
});

test('a tagged thread reply on other routes only teaches the curator', async () => {
  const { handler, sent } = setup({ github: parentBy(BOT) });
  await handler(delivery('pull_request_review_comment', reviewReply({ body: '@example-reviewer this is wrong, the caller holds the lock' })));
  assert.deepEqual(sent.map((s) => s.queueUrl), ['q-curator']);
});

test('an acknowledgement to the bot is not a summons', async () => {
  const { handler, sent, api } = setup();
  const resp = await handler(delivery('issue_comment', {
    action: 'created', installation: { id: 42 }, repository: { full_name: REPO },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 12, body: '@example-reviewer thanks!', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.equal(body(resp).skipped, 'noise:mention-short', 'it goes to the feedback path, which drops it');
  assert.equal(sent.length, 0);
  assert.equal(api.calls.length, 0);
});

const READY_ENV = {
  REVIEW_ROUTE_MAP_JSON: JSON.stringify({
    ...JSON.parse(ENV.REVIEW_ROUTE_MAP_JSON),
    [REPO]: { ...JSON.parse(ENV.REVIEW_ROUTE_MAP_JSON)[REPO], readyLabel: 'ready-for-human-review' },
    [GLIDE]: { ...JSON.parse(ENV.REVIEW_ROUTE_MAP_JSON)[GLIDE], readyLabel: 'ready-for-human-review' },
  }),
};

test('synchronize still queues the review and reconciles the ready label', async () => {
  const { handler, sent, readyLabel } = setup({ env: READY_ENV });
  const resp = await handler(delivery('pull_request', push('bbb')));
  assert.equal(body(resp).enqueued, `${REPO}#7#bbb#push`);
  assert.equal(sent[0].queueUrl, 'q-valkey');
  assert.deepEqual(readyLabel, [{ installationId: 42, repo: REPO, prNumber: 7 }]);
});

test('opened does not reconcile the ready label; closed, draft, ready_for_review and reopened do', async () => {
  const { handler, readyLabel } = setup({ env: READY_ENV });
  await handler(delivery('pull_request', prEvent('opened')));
  assert.deepEqual(readyLabel, []);
  await handler(delivery('pull_request', prEvent('closed')));
  await handler(delivery('pull_request', prEvent('converted_to_draft')));
  await handler(delivery('pull_request', prEvent('ready_for_review')));
  await handler(delivery('pull_request', prEvent('reopened')));
  assert.deepEqual(readyLabel, [
    { installationId: 42, repo: REPO, prNumber: 7 },
    { installationId: 42, repo: REPO, prNumber: 7 },
    { installationId: 42, repo: REPO, prNumber: 7 },
    { installationId: 42, repo: REPO, prNumber: 7 },
  ]);
});

test('a review thread event reconciles the label and is not curator feedback', async () => {
  const { handler, sent, readyLabel } = setup({ env: READY_ENV });
  const payload = {
    action: 'resolved',
    installation: { id: 42 },
    repository: { full_name: REPO },
    sender: { login: 'maintainer' },
    pull_request: { number: 7, user: { login: 'author' }, head: { sha: 'abc123' } },
  };
  const resp = await handler(delivery('pull_request_review_thread', payload));
  assert.equal(resp.statusCode, 200);
  assert.equal(body(resp).skipped, 'action=resolved');
  assert.equal(sent.length, 0);
  assert.deepEqual(readyLabel, [{ installationId: 42, repo: REPO, prNumber: 7 }]);
});

test('a failed ready-label invoke does not 500 the webhook', async () => {
  const { handler, sent } = setup({
    env: READY_ENV,
    syncReadyLabel: async () => { throw new Error('lambda down'); },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(String(args[0])); };
  try {
    const thread = await handler(delivery('pull_request_review_thread', {
      action: 'unresolved',
      installation: { id: 42 },
      repository: { full_name: REPO },
      sender: { login: 'maintainer' },
      pull_request: { number: 7 },
    }));
    assert.equal(thread.statusCode, 200);
    const pushed = await handler(delivery('pull_request', push('bbb')));
    assert.equal(pushed.statusCode, 200);
    assert.equal(body(pushed).enqueued, `${REPO}#7#bbb#push`);
    assert.equal(sent.length, 1);
    assert.match(errors.join('\n'), /ready-label/);
  } finally {
    console.error = original;
  }
});

test('a human review-comment reply reconciles the ready label', async () => {
  const { handler, readyLabel } = setup({ env: READY_ENV, github: parentBy(BOT) });
  await handler(delivery('pull_request_review_comment', reviewReply()));
  assert.deepEqual(readyLabel, [{ installationId: 42, repo: REPO, prNumber: 7 }]);
});

test('deleting a review comment reconciles the ready label and is not curator feedback', async () => {
  const { handler, sent, readyLabel } = setup({ env: READY_ENV, github: parentBy(BOT) });
  await handler(delivery('pull_request_review_comment', reviewReply()));
  const deleted = await handler(delivery('pull_request_review_comment', { ...reviewReply(), action: 'deleted' }));
  assert.equal(body(deleted).skipped, 'not-feedback:action=deleted');
  assert.equal(sent.length, 1, 'only the created reply reached the curator');
  assert.equal(readyLabel.length, 2);
});

test('an issue comment on a pull request reconciles the ready label; a plain issue does not', async () => {
  const { handler, readyLabel } = setup({ env: READY_ENV });
  await handler(delivery('issue_comment', {
    action: 'created', installation: { id: 42 }, repository: { full_name: REPO },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 9, body: 'Disagree with the DCO finding; the commits are signed.', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.deepEqual(readyLabel, [{ installationId: 42, repo: REPO, prNumber: 7 }]);
  await handler(delivery('issue_comment', {
    action: 'deleted', installation: { id: 42 }, repository: { full_name: REPO },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 9, body: 'Disagree with the DCO finding; the commits are signed.', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.equal(readyLabel.length, 2);
  const before = readyLabel.length;
  await handler(delivery('issue_comment', {
    action: 'created', installation: { id: 42 }, repository: { full_name: REPO },
    issue: { number: 3, user: { login: 'author' } },
    comment: { id: 10, body: 'A comment on a plain issue that is long enough.', user: { login: 'maintainer' }, author_association: 'OWNER' },
  }));
  assert.equal(readyLabel.length, before);
});

test('a failed enqueue on synchronize still reconciles the ready label', async () => {
  const { handler, readyLabel } = setup({
    env: READY_ENV,
    sendMessage: async () => { throw new Error('queue unavailable'); },
  });
  const original = console.error;
  console.error = () => {};
  try {
    const resp = await handler(delivery('pull_request', push('bbb')));
    assert.equal(resp.statusCode, 500);
    assert.deepEqual(body(resp), { error: 'internal' });
  } finally {
    console.error = original;
  }
  assert.deepEqual(readyLabel, [{ installationId: 42, repo: REPO, prNumber: 7 }]);
});

test('a summons on an unrouted repository is skipped', async () => {
  const { handler } = setup();
  const resp = await handler(delivery('issue_comment', {
    action: 'created', installation: { id: 42 }, repository: { full_name: 'someone/else' },
    issue: { number: 7, pull_request: {}, user: { login: 'author' } },
    comment: { id: 13, body: '@example-reviewer review', user: { login: 'maintainer' }, author_association: 'MEMBER' },
  }));
  assert.equal(body(resp).skipped, 'mention:unrouted-repo=someone/else');
});
