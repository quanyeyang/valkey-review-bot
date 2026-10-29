import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { loadEnv } = await import('../src/config.ts');

const base = {
  BEDROCK_MODEL_ID: 'primary-model',
  FALLBACK_MODEL_ID: 'openai.fallback-model',
  AWS_REGION: 'us-west-2',
  MANTLE_REGION: 'us-east-1',
  SUMMARIZER_MODEL_ID: 'summary-model',
  SUMMARIZER_FALLBACK_MODEL_ID: 'openai.summary-fallback',
  ASSETS_BUCKET: 'assets',
  PROMPT_S3_KEY: 'prompt.md',
  SKILL_S3_KEY: 'skill.md',
  GITHUB_APP_ID: '123456',
  TOKEN_BROKER_FUNCTION: 'token-broker',
  WORKSPACE_ROOT: '/workspace/valkey',
};

test('a minimal environment gets the documented defaults', () => {
  const env = loadEnv(base);
  assert.equal(env.modelId, 'primary-model');
  assert.equal(env.mantleRegion, 'us-east-1');
  assert.equal(env.maxIterations, 150);
  assert.equal(env.maxTokens, 32768);
  assert.equal(env.reasoningEffort, 'high');
  assert.equal(env.allowBuild, false);
  assert.equal(env.allowWrite, false);
  assert.equal(env.skillsRegistryId, '');
  assert.equal(env.heartbeatTable, '');
  assert.equal(env.upstreamRepo, '');
  assert.equal(env.workspaceRoot, '/workspace/valkey');
  assert.equal(env.readyLabelFunction, '');
});

test('model ids, regions and the workspace root are required', () => {
  for (const name of ['BEDROCK_MODEL_ID', 'FALLBACK_MODEL_ID', 'AWS_REGION', 'MANTLE_REGION', 'SUMMARIZER_MODEL_ID',
    'SUMMARIZER_FALLBACK_MODEL_ID', 'WORKSPACE_ROOT', 'GITHUB_APP_ID', 'TOKEN_BROKER_FUNCTION']) {
    assert.throws(() => loadEnv({ ...base, [name]: '' }), new RegExp(`${name} is not set`), name);
    const { [name]: _, ...without } = base;
    assert.throws(() => loadEnv(without), new RegExp(`${name} is not set`), name);
  }
});

test('numbers, booleans, effort and repo names are validated', () => {
  assert.equal(loadEnv({ ...base, MAX_ITERATIONS: '40', MAX_TOKENS: '8192' }).maxIterations, 40);
  for (const bad of ['abc', '0', '-1', '1.5', '10x', '1e3']) {
    assert.throws(() => loadEnv({ ...base, MAX_ITERATIONS: bad }), /MAX_ITERATIONS must be a positive integer/, bad);
  }
  assert.throws(() => loadEnv({ ...base, MAX_TOKENS: 'lots' }), /MAX_TOKENS/);
  assert.throws(() => loadEnv({ ...base, ALLOW_WRITE: 'yes' }), /ALLOW_WRITE must be "true" or "false"/);
  assert.equal(loadEnv({ ...base, REASONING_EFFORT: 'xhigh' }).reasoningEffort, 'xhigh');
  assert.throws(() => loadEnv({ ...base, REASONING_EFFORT: 'extreme' }), /REASONING_EFFORT must be one of/);
  assert.throws(() => loadEnv({ ...base, GITHUB_APP_ID: 'my-app' }), /GITHUB_APP_ID must be a numeric app id/);
  assert.equal(loadEnv({ ...base, UPSTREAM_REPO: 'valkey-io/valkey' }).upstreamRepo, 'valkey-io/valkey');
  assert.throws(() => loadEnv({ ...base, UPSTREAM_REPO: 'https://github.com/valkey-io/valkey' }), /UPSTREAM_REPO/);
});

test('ALLOW_MAKE is still accepted as the old name of ALLOW_BUILD', () => {
  assert.equal(loadEnv({ ...base, ALLOW_BUILD: 'true' }).allowBuild, true);
  assert.equal(loadEnv({ ...base, ALLOW_MAKE: 'TRUE' }).allowBuild, true);
  assert.equal(loadEnv({ ...base, ALLOW_MAKE: 'true' }).allowMake, true);
  assert.equal(loadEnv({ ...base, ALLOW_BUILD: 'false', ALLOW_MAKE: 'true' }).allowBuild, false);
  assert.throws(() => loadEnv({ ...base, ALLOW_MAKE: '1' }), /ALLOW_MAKE/);
});
