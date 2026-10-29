import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { createAppSecretSource, createInstallationTokens, fetchReviewComment, githubApi, githubGraphql, parseAppSecret, RECEIVER_TOKEN_PERMISSIONS } = await import('../src/github.ts');

test('parseAppSecret reads the three fields', () => {
  assert.deepEqual(parseAppSecret(JSON.stringify({ webhook_secret: 'w', private_key: 'k', app_id: 123456 })), {
    webhookSecret: 'w', privateKey: 'k', appId: '123456',
  });
  assert.deepEqual(parseAppSecret('{}'), {});
});

test('a malformed secret is reported without any of its content', () => {
  const secret = '{"webhook_secret":"hunter2-very-secret",';
  assert.throws(() => parseAppSecret(secret), (err) => {
    assert.equal(err.message, 'GitHub App secret is not valid JSON');
    assert.ok(!err.message.includes('hunter2'));
    return true;
  });
  assert.throws(() => parseAppSecret(undefined), /not valid JSON/);
  assert.throws(() => parseAppSecret('"just a string"'), /not a JSON object/);
});

test('the secret is cached for five minutes', async () => {
  let fetches = 0;
  let now = 0;
  const source = createAppSecretSource(async () => { fetches++; return JSON.stringify({ webhook_secret: `s${fetches}` }); }, () => now);
  assert.equal((await source.get()).webhookSecret, 's1');
  now = 4 * 60_000;
  assert.equal((await source.get()).webhookSecret, 's1');
  now = 5 * 60_000 + 1;
  assert.equal((await source.get()).webhookSecret, 's2');
  assert.equal(fetches, 2);
});

test('refresh refetches at most once a minute', async () => {
  let fetches = 0;
  let now = 0;
  const source = createAppSecretSource(async () => { fetches++; return JSON.stringify({ webhook_secret: `s${fetches}` }); }, () => now);
  await source.get();
  now = 30_000;
  assert.equal((await source.refresh()).webhookSecret, 's1', 'fetched 30 s ago: cached copy');
  now = 61_000;
  assert.equal((await source.refresh()).webhookSecret, 's2');
  assert.equal((await source.get()).webhookSecret, 's2', 'the refreshed copy is the cached one');
  assert.equal((await source.refresh()).webhookSecret, 's2');
  assert.equal(fetches, 2);
});

test('githubApi sends an authenticated JSON request with a timeout', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  };
  const api = githubApi('tok', fakeFetch);
  assert.deepEqual(await api('POST', 'repos/o/r/issues/1/comments', { body: 'hi' }), { status: 201, json: { id: 1 } });
  const { url, init } = requests[0];
  assert.equal(url, 'https://api.github.com/repos/o/r/issues/1/comments');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, '{"body":"hi"}');
  assert.ok(init.signal instanceof AbortSignal);
});

test('githubApi tolerates an empty body', async () => {
  const api = githubApi('tok', async () => new Response(null, { status: 204 }));
  assert.deepEqual(await api('GET', 'x'), { status: 204, json: {} });
});

test('githubApi can DELETE', async () => {
  const requests = [];
  const api = githubApi('tok', async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await api('DELETE', 'repos/o/r/issues/1/labels/ready-for-human-review'), { status: 204, json: {} });
  assert.equal(requests[0].init.method, 'DELETE');
  assert.equal(requests[0].init.body, undefined);
});

test('githubGraphql posts the query and returns data', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  assert.deepEqual(await githubGraphql('tok', 'query { viewer { login } }', { n: 1 }, fakeFetch), { ok: true });
  assert.equal(requests[0].url, 'https://api.github.com/graphql');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { query: 'query { viewer { login } }', variables: { n: 1 } });
});

test('githubGraphql reports GraphQL errors without returning partial data', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: 200 });
  await assert.rejects(githubGraphql('tok', 'query { x }', {}, fakeFetch), /rate limited/);
});

test('fetchReviewComment returns the comment author, anchor and body', async () => {
  const api = async () => ({ status: 200, json: { body: 'b', user: { login: 'u' }, path: 'p.c', line: null, original_line: 3 } });
  assert.deepEqual(await fetchReviewComment(api, 'o/r', 1), { body: 'b', author: 'u', path: 'p.c', line: 3 });
  assert.equal(await fetchReviewComment(async () => ({ status: 404, json: {} }), 'o/r', 1), undefined);
});

test('receiver tokens ask for exactly the permissions the receiver uses, never contents', async () => {
  const requests = [];
  const secrets = { get: async () => ({ appId: '1', privateKey: 'k' }), refresh: async () => ({ appId: '1', privateKey: 'k' }) };
  const tokens = createInstallationTokens(secrets, async (r) => {
    requests.push(r);
    return { token: `t${requests.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  });
  assert.equal(await tokens(42), 't1');
  assert.equal(await tokens(42), 't1');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].permissions, { pull_requests: 'write', issues: 'read', metadata: 'read' });
  assert.equal(requests[0].installationId, 42);
  assert.equal('contents' in RECEIVER_TOKEN_PERMISSIONS, false);
});
