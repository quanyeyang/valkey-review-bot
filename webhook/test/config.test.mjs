import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const {
  botMatcher, DEFAULT_KNOWN_BOT_LOGINS, isAppLogin, loadInvokerConfig, loadReceiverConfig, parseKnownBotLogins,
} = await import('../src/config.ts');

const ROUTES = {
  'Example-Org/Valkey': { routeId: 'valkey-review', queueUrl: 'https://sqs.example/q1', reviewerId: 'valkey-review' },
  'example-org/valkey-glide': {
    routeId: 'valkey-glide-review', queueUrl: 'https://sqs.example/q2', reviewerId: 'valkey-glide-review',
    authorAllowlist: ['Some-Maintainer'], skipDrafts: true, threadReplyReview: true,
  },
};

const base = {
  REVIEW_ROUTE_MAP_JSON: JSON.stringify(ROUTES),
  IDEMPOTENCY_TABLE: 'idempotency',
  GITHUB_SECRET_ARN: 'example-secret',
  BOT_LOGIN: 'example-reviewer[bot]',
  HAIKU_MODEL_ID: 'safety-model',
};

test('a minimal receiver environment gets the documented defaults', () => {
  const config = loadReceiverConfig(base);
  assert.equal(config.dailyReviewBudget, 40);
  assert.equal(config.maxAutomaticReviewsPerPr, 3);
  assert.equal(config.pushReviewDelaySeconds, 300);
  assert.equal(config.installationId, undefined);
  assert.equal(config.curatorQueueUrl, '');
  assert.equal(config.curatorRoutes.size, 0);
  assert.equal(config.safetyModelId, 'safety-model');
  assert.deepEqual([...config.knownBotLogins], DEFAULT_KNOWN_BOT_LOGINS);
});

test('routes are keyed by lowercased repository and carry their route id', () => {
  const { reviewRoutes } = loadReceiverConfig(base);
  assert.deepEqual(reviewRoutes.get('example-org/valkey'), {
    routeId: 'valkey-review', queueUrl: 'https://sqs.example/q1', reviewerId: 'valkey-review',
    authorAllowlist: [], mentionOnly: false, skipDrafts: false, threadReplyReview: false,
  });
  const glide = reviewRoutes.get('example-org/valkey-glide');
  assert.deepEqual(glide.authorAllowlist, ['some-maintainer']);
  assert.equal(glide.skipDrafts, true);
  assert.equal(glide.threadReplyReview, true);
  assert.equal(glide.readyLabel, undefined);
});

test('readyLabel is optional and must be a non-empty string when set', () => {
  const withRoute = (entry) => ({ ...base, REVIEW_ROUTE_MAP_JSON: JSON.stringify({ 'o/r': entry }) });
  const good = { routeId: 'r', queueUrl: 'q', reviewerId: 'v', readyLabel: 'ready-for-human-review' };
  assert.equal(loadReceiverConfig(withRoute(good)).reviewRoutes.get('o/r').readyLabel, 'ready-for-human-review');
  assert.equal(loadReceiverConfig(withRoute({ ...good, readyLabel: undefined })).reviewRoutes.get('o/r').readyLabel, undefined);
  assert.throws(() => loadReceiverConfig(withRoute({ ...good, readyLabel: 1 })), /readyLabel must be a non-empty string/);
});

test('required settings have no defaults', () => {
  for (const name of ['REVIEW_ROUTE_MAP_JSON', 'IDEMPOTENCY_TABLE', 'GITHUB_SECRET_ARN', 'BOT_LOGIN', 'HAIKU_MODEL_ID']) {
    assert.throws(() => loadReceiverConfig({ ...base, [name]: '' }), new RegExp(`${name} is not set`), name);
    assert.throws(() => loadReceiverConfig({ ...base, [name]: undefined }), new RegExp(`${name} is not set`), name);
  }
});

test('route entries are validated', () => {
  const withRoute = (entry) => ({ ...base, REVIEW_ROUTE_MAP_JSON: JSON.stringify({ 'o/r': entry }) });
  const good = { routeId: 'r', queueUrl: 'q', reviewerId: 'v' };
  assert.throws(() => loadReceiverConfig(withRoute({ ...good, routeId: undefined })), /routeId must be a non-empty string/);
  assert.throws(() => loadReceiverConfig(withRoute({ ...good, skipDrafts: 'yes' })), /skipDrafts must be true or false/);
  assert.throws(() => loadReceiverConfig(withRoute({ ...good, authorAllowlist: 'someone' })), /authorAllowlist/);
  assert.throws(() => loadReceiverConfig({ ...base, REVIEW_ROUTE_MAP_JSON: '[]' }), /JSON object/);
  assert.throws(() => loadReceiverConfig({ ...base, REVIEW_ROUTE_MAP_JSON: '{' }), /REVIEW_ROUTE_MAP_JSON is not valid JSON/);
  assert.throws(
    () => loadReceiverConfig({ ...base, CURATOR_ROUTE_MAP_JSON: JSON.stringify({ 'o/r': {} }) }),
    /CURATOR_ROUTE_MAP_JSON\["o\/r"\]\.reviewerId/,
  );
});

test('the daily budget accepts 0 and rejects anything but a non-negative integer', () => {
  assert.equal(loadReceiverConfig({ ...base, DAILY_REVIEW_BUDGET: '0' }).dailyReviewBudget, 0);
  assert.equal(loadReceiverConfig({ ...base, DAILY_REVIEW_BUDGET: '7' }).dailyReviewBudget, 7);
  for (const bad of ['-1', '1.5', 'many', '1e3']) {
    assert.throws(() => loadReceiverConfig({ ...base, DAILY_REVIEW_BUDGET: bad }), /DAILY_REVIEW_BUDGET/, bad);
  }
});

test('automatic reviews per PR range from 1 to 20', () => {
  assert.equal(loadReceiverConfig({ ...base, MAX_AUTOMATIC_REVIEWS_PER_PR: '1' }).maxAutomaticReviewsPerPr, 1);
  assert.equal(loadReceiverConfig({ ...base, MAX_AUTOMATIC_REVIEWS_PER_PR: '20' }).maxAutomaticReviewsPerPr, 20);
  for (const bad of ['0', '21', '-1', '2.5', 'three']) {
    assert.throws(
      () => loadReceiverConfig({ ...base, MAX_AUTOMATIC_REVIEWS_PER_PR: bad }),
      /MAX_AUTOMATIC_REVIEWS_PER_PR must be an integer from 1 to 20/,
      bad,
    );
  }
});

test('the push review delay ranges from 0 to 900 seconds, the SQS maximum', () => {
  assert.equal(loadReceiverConfig({ ...base, PUSH_REVIEW_DELAY_SECONDS: '0' }).pushReviewDelaySeconds, 0);
  assert.equal(loadReceiverConfig({ ...base, PUSH_REVIEW_DELAY_SECONDS: '900' }).pushReviewDelaySeconds, 900);
  for (const bad of ['901', '-5', '1e2', '5m']) {
    assert.throws(
      () => loadReceiverConfig({ ...base, PUSH_REVIEW_DELAY_SECONDS: bad }),
      /PUSH_REVIEW_DELAY_SECONDS must be an integer from 0 to 900/,
      bad,
    );
  }
});

test('INSTALLATION_ID is optional and numeric', () => {
  assert.equal(loadReceiverConfig({ ...base, INSTALLATION_ID: '42' }).installationId, 42);
  assert.throws(() => loadReceiverConfig({ ...base, INSTALLATION_ID: 'abc' }), /INSTALLATION_ID/);
});

test('KNOWN_BOT_LOGINS replaces the built-in list; unset or empty keeps it', () => {
  assert.deepEqual([...parseKnownBotLogins('One[bot], two ,')], ['one[bot]', 'two']);
  assert.deepEqual([...parseKnownBotLogins('')], DEFAULT_KNOWN_BOT_LOGINS);
  assert.deepEqual([...parseKnownBotLogins(' , ')], DEFAULT_KNOWN_BOT_LOGINS);
  assert.deepEqual([...parseKnownBotLogins(undefined)], DEFAULT_KNOWN_BOT_LOGINS);
});

test('botMatcher recognizes bot users by type, suffix, this App and the list', () => {
  const isBot = botMatcher('Example-Reviewer[bot]', new Set(['coderabbitai']));
  assert.equal(isBot({ login: 'anything', type: 'Bot' }), true);
  assert.equal(isBot({ login: 'some-app[bot]', type: 'User' }), true);
  assert.equal(isBot({ login: 'example-reviewer[bot]' }), true);
  assert.equal(isBot({ login: 'CodeRabbitAI', type: 'User' }), true);
  assert.equal(isBot({ login: 'maintainer', type: 'User' }), false);
  assert.equal(isBot(undefined), false);
});

test('isAppLogin matches only this App', () => {
  assert.equal(isAppLogin('Example-Reviewer[bot]', 'example-reviewer[bot]'), true);
  assert.equal(isAppLogin('other-reviewer[bot]', 'example-reviewer[bot]'), false);
  assert.equal(isAppLogin('example-reviewer', 'example-reviewer[bot]'), false);
  assert.equal(isAppLogin(undefined, 'example-reviewer[bot]'), false);
});

test('the invoker needs a runtime and takes its thresholds from the environment', () => {
  assert.deepEqual(loadInvokerConfig({ RUNTIME_ARN: 'runtime' }), {
    runtimeArn: 'runtime', heartbeatTable: '', runBudgetMs: 90 * 60_000, staleMs: 12 * 60_000, idempotencyTable: '',
  });
  const custom = loadInvokerConfig({
    RUNTIME_ARN: 'runtime', HEARTBEAT_TABLE: 'hb', RUN_BUDGET_MINUTES: '120', HEARTBEAT_STALE_MINUTES: '20', IDEMPOTENCY_TABLE: ' idem ',
  });
  assert.equal(custom.heartbeatTable, 'hb');
  assert.equal(custom.idempotencyTable, 'idem');
  assert.equal(custom.runBudgetMs, 120 * 60_000);
  assert.equal(custom.staleMs, 20 * 60_000);
  assert.throws(() => loadInvokerConfig({}), /RUNTIME_ARN is not set/);
  assert.throws(() => loadInvokerConfig({ RUNTIME_ARN: 'r', RUN_BUDGET_MINUTES: '0' }), /RUN_BUDGET_MINUTES must be an integer >= 1/);
  assert.throws(() => loadInvokerConfig({ RUNTIME_ARN: 'r', HEARTBEAT_STALE_MINUTES: 'soon' }), /HEARTBEAT_STALE_MINUTES/);
});
