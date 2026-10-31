import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Octokit } from '@octokit/rest';

/**
 * GitHub credentials for one review run.
 *
 * The runtime never holds the GitHub App private key. It asks the token
 * broker (webhook/src/token-broker.ts) for an installation token limited
 * to the repository under review, and asks again shortly before that
 * token expires, so runs longer than the one-hour token lifetime keep
 * working.
 */

export interface TokenSource {
  /** A token valid for at least the next few minutes. */
  get(): Promise<string>;
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

export function createTokenSource(opts: {
  brokerFunction: string;
  region: string;
  installationId: number;
  repo: string;
}): TokenSource {
  const lambda = new LambdaClient({ region: opts.region });
  let current: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: opts.brokerFunction,
      Payload: Buffer.from(JSON.stringify({ installation_id: opts.installationId, repo: opts.repo })),
    }));
    if (resp.FunctionError) throw new Error(`token broker failed (${resp.FunctionError})`);
    const out = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString('utf8')) as
      { token?: string; expires_at?: string; error?: string };
    if (!out.token || !out.expires_at) throw new Error(`token broker refused: ${out.error ?? 'no token returned'}`);
    current = { token: out.token, expiresAt: new Date(out.expires_at).getTime() };
    return out.token;
  }

  return {
    async get(): Promise<string> {
      if (current && current.expiresAt - Date.now() > REFRESH_BEFORE_EXPIRY_MS) return current.token;
      // One refresh at a time; concurrent callers share it.
      pending ??= fetchToken().finally(() => { pending = null; });
      return pending;
    },
  };
}

/** Octokit that attaches a current token to every request. */
export function createOctokit(tokens: TokenSource): Octokit {
  const octokit = new Octokit();
  octokit.hook.before('request', async (options) => {
    options.headers.authorization = `token ${await tokens.get()}`;
  });
  return octokit;
}

/**
 * Fire-and-forget invoke of the ready-label Lambda. Never throws: a
 * failed invoke is logged and the review continues. The function mints
 * its own pull_requests:write token; this payload is only the PR identity.
 */
export function createReadyLabelInvoker(opts: {
  functionName: string;
  region: string;
  installationId: number;
  repo: string;
  prNumber: number;
}): () => Promise<void> {
  const lambda = new LambdaClient({ region: opts.region });
  return async () => {
    try {
      await lambda.send(new InvokeCommand({
        FunctionName: opts.functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          installation_id: opts.installationId,
          repo: opts.repo,
          pr_number: opts.prNumber,
        })),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ready-label] invoke failed: ${msg}`);
    }
  };
}
