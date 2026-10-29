import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * Reasoning effort levels accepted by both model paths: Converse
 * `output_config.effort` and Mantle `reasoning.effort`.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AgentEnv {
  /** Primary reviewer model. `openai.*` ids go through Bedrock Mantle, others through Converse. */
  readonly modelId: string;
  /**
   * Model used when the invocation payload sets `use_fallback_model`. The
   * invoker sets it on redelivery, after an attempt on the primary failed.
   */
  readonly fallbackModelId: string;
  /** Region of the runtime and of the Converse, S3, DynamoDB and Lambda clients. */
  readonly region: string;
  /**
   * Region of the Bedrock Mantle endpoint for `openai.*` models. Separate
   * from `region` because Mantle models are not served in every region.
   */
  readonly mantleRegion: string;
  readonly reasoningEffort: ReasoningEffort;
  /** Small model that writes the one-line progress notes on mention-triggered runs. */
  readonly summarizerModelId: string;
  readonly summarizerFallbackModelId: string;
  readonly assetsBucket: string;
  readonly promptKey: string;
  readonly skillKey: string;
  readonly githubAppId: string;
  /** Lambda that issues repo-scoped GitHub tokens (see github-auth.ts). */
  readonly tokenBrokerFunction: string;
  /**
   * Lambda that projects readiness onto a PR label. Empty when the
   * deployment has no readyLabel on any route.
   */
  readonly readyLabelFunction: string;
  /**
   * Id (or ARN) of the AWS Agent Registry registry holding this reviewer's
   * graduated skills. Empty means none; the system prompt then has no
   * graduated-skills section.
   */
  readonly skillsRegistryId: string;
  /** DynamoDB table the runtime heartbeats into during a review. Empty disables heartbeats. */
  readonly heartbeatTable: string;
  /** Upper bound on model calls in one run, retries included. */
  readonly maxIterations: number;
  readonly maxTokens: number;
  /** The repository clone baked into the image. */
  readonly workspaceRoot: string;
  /** Exposes the write/edit tools so the agent can test assumptions in the workspace. */
  readonly allowWrite: boolean;
  /** Exposes the reviewer's build/test tool (make for valkey, the language toolchains for glide). */
  readonly allowBuild: boolean;
  /** @deprecated Same value as `allowBuild`; kept while agents still read the old name. */
  readonly allowMake: boolean;
  /**
   * "owner/name" of the canonical repository whose release branches the
   * backport check reads. Empty means the PR's own repository.
   */
  readonly upstreamRepo: string;
}

const DEFAULT_MAX_ITERATIONS = 150;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

type EnvSource = Readonly<Record<string, string | undefined>>;

function required(env: EnvSource, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`required env var ${name} is not set`);
  return value;
}

function optional(env: EnvSource, name: string): string {
  return env[name]?.trim() ?? '';
}

function positiveInt(env: EnvSource, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function bool(env: EnvSource, name: string, raw: string = optional(env, name)): boolean {
  const value = raw.toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

function reasoningEffort(env: EnvSource): ReasoningEffort {
  const raw = optional(env, 'REASONING_EFFORT');
  if (!raw) return DEFAULT_REASONING_EFFORT;
  const match = REASONING_EFFORTS.find((e) => e === raw);
  if (!match) throw new Error(`REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}, got "${raw}"`);
  return match;
}

function upstreamRepo(env: EnvSource): string {
  const value = optional(env, 'UPSTREAM_REPO');
  if (value && !REPO_RE.test(value)) throw new Error(`UPSTREAM_REPO must look like "owner/name", got "${value}"`);
  return value;
}

export function loadEnv(env: EnvSource = process.env): AgentEnv {
  const githubAppId = required(env, 'GITHUB_APP_ID');
  if (!/^\d+$/.test(githubAppId)) throw new Error(`GITHUB_APP_ID must be a numeric app id, got "${githubAppId}"`);

  // ALLOW_MAKE is the older name of ALLOW_BUILD; ALLOW_BUILD wins when both are set.
  const buildRaw = optional(env, 'ALLOW_BUILD');
  const allowBuild = buildRaw
    ? bool(env, 'ALLOW_BUILD', buildRaw)
    : bool(env, 'ALLOW_MAKE');

  return {
    modelId: required(env, 'BEDROCK_MODEL_ID'),
    fallbackModelId: required(env, 'FALLBACK_MODEL_ID'),
    region: required(env, 'AWS_REGION'),
    mantleRegion: required(env, 'MANTLE_REGION'),
    reasoningEffort: reasoningEffort(env),
    summarizerModelId: required(env, 'SUMMARIZER_MODEL_ID'),
    summarizerFallbackModelId: required(env, 'SUMMARIZER_FALLBACK_MODEL_ID'),
    assetsBucket: required(env, 'ASSETS_BUCKET'),
    promptKey: required(env, 'PROMPT_S3_KEY'),
    skillKey: required(env, 'SKILL_S3_KEY'),
    githubAppId,
    tokenBrokerFunction: required(env, 'TOKEN_BROKER_FUNCTION'),
    readyLabelFunction: optional(env, 'READY_LABEL_FUNCTION'),
    skillsRegistryId: optional(env, 'SKILLS_REGISTRY_ID'),
    heartbeatTable: optional(env, 'HEARTBEAT_TABLE'),
    maxIterations: positiveInt(env, 'MAX_ITERATIONS', DEFAULT_MAX_ITERATIONS),
    maxTokens: positiveInt(env, 'MAX_TOKENS', DEFAULT_MAX_TOKENS),
    workspaceRoot: required(env, 'WORKSPACE_ROOT'),
    allowWrite: bool(env, 'ALLOW_WRITE'),
    allowBuild,
    allowMake: allowBuild,
    upstreamRepo: upstreamRepo(env),
  };
}

export async function loadAssets(env: AgentEnv): Promise<{ prompt: string; skill: string }> {
  const s3 = new S3Client({ region: env.region });
  const fetch = async (key: string): Promise<string> => {
    const resp = await s3.send(new GetObjectCommand({ Bucket: env.assetsBucket, Key: key }));
    if (!resp.Body) throw new Error(`empty S3 object ${env.assetsBucket}/${key}`);
    return resp.Body.transformToString('utf8');
  };
  const [prompt, skill] = await Promise.all([fetch(env.promptKey), fetch(env.skillKey)]);
  return { prompt, skill };
}
