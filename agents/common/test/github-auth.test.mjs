import assert from 'node:assert/strict';
import test from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import './support/ts-resolve.mjs';

const { createReadyLabelInvoker } = await import('../src/github-auth.ts');

test('createReadyLabelInvoker sends one async Event carrying only the PR identity', async (t) => {
  const sent = [];
  t.mock.method(LambdaClient.prototype, 'send', async (command) => {
    sent.push(command.input);
    return {};
  });
  const invoke = createReadyLabelInvoker({
    functionName: 'ready-label',
    region: 'us-west-2',
    installationId: 42,
    repo: 'valkey-io/valkey',
    prNumber: 7,
  });
  await invoke();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].FunctionName, 'ready-label');
  assert.equal(sent[0].InvocationType, 'Event');
  assert.deepEqual(JSON.parse(Buffer.from(sent[0].Payload).toString()), {
    installation_id: 42,
    repo: 'valkey-io/valkey',
    pr_number: 7,
  });
  assert.equal(JSON.stringify(sent[0]).includes('token'), false);
});

test('a failed ready-label invoke is logged and does not throw', async (t) => {
  t.mock.method(LambdaClient.prototype, 'send', async () => {
    throw new Error('lambda down');
  });
  const lines = [];
  const original = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    await createReadyLabelInvoker({
      functionName: 'ready-label',
      region: 'us-west-2',
      installationId: 42,
      repo: 'valkey-io/valkey',
      prNumber: 7,
    })();
  } finally {
    console.warn = original;
  }
  assert.match(lines.join('\n'), /lambda down/);
});
