import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAppAuth } from '@octokit/auth-app';
import { parseKnownBotLogins } from './config.js';
import { githubApi, githubGraphql } from './github.js';
import { createReadyLabelApplier, type ReadyLabelEvent, type ReadyLabelResult } from './ready-label.js';

/**
 * Ready-label Lambda.
 *
 * Reviewer runtimes and the webhook receiver invoke this function
 * (IAM lambda:InvokeFunction) after a state write or a PR / thread event
 * that can change readiness. It mints an installation token with
 * issues:write itself, reconciles one configured label on that pull
 * request, and never returns a token. The label name and the repository
 * allowlist come from the environment. The caller sends only
 * `{ installation_id, repo, pr_number }`.
 *
 * The function is created only when at least one route sets readyLabel.
 * Checks are in src/ready-label.ts.
 *
 * Env:    GITHUB_SECRET_ARN, GITHUB_APP_ID, BOT_LOGIN, ALLOWED_REPOS_JSON,
 *         READY_LABEL_BY_REPO_JSON, optional KNOWN_BOT_LOGINS
 * Input:  { installation_id, repo, pr_number }
 * Output: { ok, decision } or { error }
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function jsonArray(name: string): string[] {
  const raw = required(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON array of repository names`);
  }
  return parsed;
}

function jsonStringMap(name: string): Record<string, string> {
  const raw = required(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object keyed by repository`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value) throw new Error(`${name}[${JSON.stringify(key)}] must be a non-empty string`);
    out[key] = value;
  }
  return out;
}

const SECRET_ARN = required('GITHUB_SECRET_ARN');
const APP_ID = required('GITHUB_APP_ID');
const BOT_LOGIN = required('BOT_LOGIN');
const ALLOWED_REPOS = jsonArray('ALLOWED_REPOS_JSON');
const LABELS_BY_REPO = jsonStringMap('READY_LABEL_BY_REPO_JSON');
const KNOWN_BOT_LOGINS = parseKnownBotLogins(process.env.KNOWN_BOT_LOGINS);

const sm = new SecretsManagerClient({});
let cachedKey: { value: string; fetchedAt: number } | null = null;

async function privateKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.fetchedAt < 5 * 60_000) return cachedKey.value;
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  let key: unknown;
  try {
    key = (JSON.parse(SecretString ?? '') as { private_key?: unknown }).private_key;
  } catch {
    throw new Error('GitHub App secret is not valid JSON');
  }
  if (typeof key !== 'string' || !key) throw new Error('GitHub App secret has no private_key');
  cachedKey = { value: key, fetchedAt: Date.now() };
  return key;
}

const appAuth = async () => createAppAuth({ appId: APP_ID, privateKey: await privateKey() });

const apply = createReadyLabelApplier({
  allowedRepos: ALLOWED_REPOS,
  labelsByRepo: LABELS_BY_REPO,
  appId: Number(APP_ID),
  botLogin: BOT_LOGIN,
  knownBotLogins: KNOWN_BOT_LOGINS,
  appApi: async () => githubApi((await (await appAuth())({ type: 'app' })).token),
  issueToken: async (request) => (await appAuth())({ type: 'installation', ...request }),
  githubApi,
  graphql: githubGraphql,
});

export async function handler(event: ReadyLabelEvent): Promise<ReadyLabelResult> {
  try {
    return await apply(event);
  } catch (err) {
    console.error('[ready-label] failed', err);
    return { error: 'internal' };
  }
}
