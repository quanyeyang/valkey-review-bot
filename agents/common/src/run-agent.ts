import { z } from 'zod';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, AfterToolCallEvent, BeforeModelCallEvent, type AgentStreamEvent, type Model, type Tool } from '@strands-agents/sdk';
import type { Octokit } from '@octokit/rest';

import { loadEnv, loadAssets, type AgentEnv } from './config.js';
import { createOctokit, createReadyLabelInvoker, createTokenSource, type TokenSource } from './github-auth.js';
import { createHeartbeat } from './heartbeat.js';
import { prepareWorkspace, renderPrOverview, type PrContext } from './workspace.js';
import { labelSuppressedPieces, loadGraduatedSkills, renderGraduatedSkills } from './graduated-skills.js';
import { createStatusComment, type StatusComment } from './status-comment.js';
import { ModelCallLimit, ReviewConversationManager, StreamStallRetryStrategy, textDelta } from './agent-loop.js';
import { createConverseModel, createMantleModel, isMantleModel } from './models.js';
import { isTerminalCallbackWired, type TerminalToolName } from './tools/gh.js';

/**
 * Shared bedrock-agentcore entrypoint + Strands loop.
 *
 * Per-agent code only needs to:
 *   - implement `assembleTools(baseOpts)`, which returns the Strands tool
 *     array (common harness/git/gh tools + agent-specific build tools)
 *   - call `bootstrap({ assembleTools })` from its agent.ts
 *
 * Prompt and skill loading, workspace preparation, the model loop,
 * terminal-tool tracking, SSE frames, and failure cleanup all live here.
 * createReviewHandler is the per-invocation part on its own, with the
 * AWS and GitHub clients injectable for tests.
 */

export interface AssembleBaseOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly tokens: TokenSource;
  readonly allowWrite: boolean;
  readonly env: AgentEnv;
  /** Present on mention-triggered runs; terminal tools edit it instead of posting a separate summary. */
  readonly statusComment?: StatusComment;
  /**
   * Pass this to assembleCommonTools. post_review and skip_review call it
   * when they succeed, and that is how the run knows the review is done.
   */
  readonly onTerminal?: (tool: TerminalToolName, result: string) => void;
  /** After a successful state write; pass through to assembleCommonTools. */
  readonly syncReadyLabel?: () => Promise<void>;
}

export type AssembleTools = (opts: AssembleBaseOpts) => Promise<readonly unknown[]>;

export interface RunAgentConfig {
  readonly assembleTools: AssembleTools;
}

export const requestSchema = z.object({
  repo: z.string(),
  pr_number: z.number().int().positive(),
  installation_id: z.number().int().positive(),
  head_sha: z.string().optional(),
  use_fallback_model: z.boolean().optional(),
  // Mention-trigger fields (receiver's mention path). instruction is
  // already safety-approved; status_comment_id is the ack comment the
  // runtime edits through the run.
  instruction: z.string().optional(),
  instruction_actor: z.string().optional(),
  status_comment_id: z.number().int().positive().optional(),
  run_nonce: z.string().optional(),
  trigger_path: z.string().optional(),
  trigger_line: z.number().int().positive().optional(),
  // Automatic-review fields (receiver's pull_request path). trigger is
  // "opened", "reopened", "ready_for_review" or "push" (new commits), and
  // is absent on @mention runs; skip_drafts is the route's skipDrafts. An
  // automatic review can wait a long time before it runs, so the run
  // checks again that the PR still wants it (see automaticReviewSkipReason
  // in workspace.ts). Any string is accepted, so a receiver that sends a
  // new trigger does not fail the run.
  trigger: z.string().optional(),
  skip_drafts: z.boolean().optional(),
});

export type Payload = z.infer<typeof requestSchema>;

/** One SSE frame the handler yields to bedrock-agentcore. */
export interface RunEvent {
  readonly event: string;
  readonly data: unknown;
}

/** The parts of a run that reach AWS or GitHub. Tests replace them. */
export interface RunDeps {
  readonly createModel: (env: AgentEnv, modelId: string) => Model;
  readonly createHeartbeat: typeof createHeartbeat;
  readonly createTokenSource: typeof createTokenSource;
  readonly createOctokit: typeof createOctokit;
  readonly prepareWorkspace: typeof prepareWorkspace;
  readonly loadGraduatedSkills: typeof loadGraduatedSkills;
  readonly createStatusComment: typeof createStatusComment;
}

function createModel(env: AgentEnv, modelId: string): Model {
  return isMantleModel(modelId)
    ? createMantleModel({ modelId, maxTokens: env.maxTokens, mantleRegion: env.mantleRegion, effort: env.reasoningEffort })
    : createConverseModel({ modelId, maxTokens: env.maxTokens, region: env.region, effort: env.reasoningEffort });
}

const DEFAULT_DEPS: RunDeps = {
  createModel,
  createHeartbeat,
  createTokenSource,
  createOctokit,
  prepareWorkspace,
  loadGraduatedSkills,
  createStatusComment,
};

export interface ReviewHandlerOpts {
  readonly env: AgentEnv;
  /** Reviewer prompt plus the baked-in skill; graduated skills are appended per run. */
  readonly systemPrompt: string;
  readonly assembleTools: AssembleTools;
  readonly deps?: Partial<RunDeps>;
}

/**
 * Model calls the follow-up prompt always gets, even past MAX_ITERATIONS:
 * one to call the terminal tool, one after its result, one spare for a
 * call the tool rejected.
 */
const TERMINAL_RETRY_CALLS = 3;

const TERMINAL_RETRY_MESSAGE = [
  'Your previous response ended without calling a terminal review tool, so the review is incomplete.',
  'Do not continue in free text. If you found one or more evidence-backed findings, call `post_review` now.',
  'If no finding meets the evidence bar, call `skip_review` now with a one-sentence reason.',
  'You must call exactly one of `post_review` or `skip_review`.',
].join('\n');

function isTool(value: unknown): value is Tool {
  const t = value as Partial<Tool> | null;
  return typeof t === 'object' && t !== null
    && typeof t.name === 'string' && typeof t.toolSpec === 'object' && typeof t.stream === 'function';
}

function toToolList(tools: readonly unknown[]): Tool[] {
  return tools.map((t, i) => {
    if (!isTool(t)) throw new Error(`assembleTools returned a value that is not a Strands tool at index ${i}`);
    return t;
  });
}

export function mentionBlock(payload: Payload): string[] {
  const lines = [
    '',
    '---',
    '',
    `## Review request from @${payload.instruction_actor ?? 'a maintainer'}`,
    '',
    'This review was requested by a maintainer tagging you on the PR. Their instruction below is the MAIN directive of this review: prioritize it over the default review flow, while still applying your evidence bar.',
  ];
  if (payload.trigger_path) {
    // The path comes from the PR (a file name the author chose), so it is
    // quoted as a JSON string: no newline or backtick can end the sentence.
    lines.push(`The request was made inline on ${JSON.stringify(payload.trigger_path)}${payload.trigger_line ? ` line ${payload.trigger_line}` : ''}; weight that area accordingly.`);
  }
  lines.push(
    '',
    payload.instruction?.trim()
      ? `### Instruction\n\n${payload.instruction.trim()}`
      : '### Instruction\n\n(No specific instruction was given. Perform your standard full review.)',
    '',
    'The PR conversation may hold context for this request; use `gh_api_read` on the PR comments/reviews endpoints to read it.',
  );
  return lines;
}

/**
 * The invocation handler: one review per payload, streamed as SSE frames.
 * bedrock-agentcore stops reading, and closes this generator at its next
 * yield, when the client disconnects. A close before the review phase
 * ends the run; a close during it does not, and the review runs to its
 * end before the generator finishes closing.
 */
export function createReviewHandler(opts: ReviewHandlerOpts): (payload: Payload) => AsyncGenerator<RunEvent, void, unknown> {
  const { env, assembleTools } = opts;
  const deps: RunDeps = { ...DEFAULT_DEPS, ...opts.deps };

  return async function* (payload: Payload) {
    const useFallback = payload.use_fallback_model === true;
    const modelId = useFallback ? env.fallbackModelId : env.modelId;
    const model = deps.createModel(env, modelId);
    console.log(`[invoke] model=${modelId}${useFallback ? ' (fallback)' : ''}${isMantleModel(modelId) ? ' (mantle)' : ''}`);

    // Liveness ledger: the SQS worker reads this on redelivery to tell
    // "slow but alive" from "dead". It is written before workspace prep,
    // which beats only once at the start, so prep must finish well inside
    // the watchdog's staleness window. Mention runs append a
    // nonce: the same head SHA may already carry a completed record
    // from the PR-opened review, which would make the watchdog ack a
    // fresh summons as already done.
    const runKey = `${payload.repo}#${payload.pr_number}#${payload.head_sha ?? 'unknown'}${payload.run_nonce ? `#${payload.run_nonce}` : ''}`;
    const heartbeat = deps.createHeartbeat({
      tableName: env.heartbeatTable,
      region: env.region,
      runKey,
      modelId,
    });
    heartbeat.beat();

    // Set by post_review / skip_review through onTerminal, only when they succeed.
    const terminal: { tool: TerminalToolName | null; result: string } = { tool: null, result: '' };
    const onTerminal = (tool: TerminalToolName, result: string): void => {
      terminal.tool = tool;
      terminal.result = result;
      console.log(`[stream] terminal tool ${tool} succeeded`);
      // The review is on GitHub now, so the run is complete whatever
      // happens next. Recording that right away covers exits that never
      // reach the end of this generator, such as the runtime being
      // stopped; a record left on "running" or set to "failed" would
      // make the invoker review the PR again.
      void heartbeat.finish('completed');
    };

    let statusComment: StatusComment | undefined;
    // Everything below runs under this try, so a failure, or the
    // caller closing the stream early, still stops the status comment
    // timer and records how the run ended.
    try {
      yield { event: 'status', data: { phase: 'auth', model: modelId } };
      const tokens = deps.createTokenSource({
        brokerFunction: env.tokenBrokerFunction,
        region: env.region,
        installationId: payload.installation_id,
        repo: payload.repo,
      });
      await tokens.get(); // fail fast if the broker refuses this repo
      const octokit = deps.createOctokit(tokens);

      // Mention-triggered run: take over the receiver's ack comment.
      // The opener (or fallback notice) goes up before the slow
      // workspace phase so the requester sees life immediately.
      if (payload.status_comment_id !== undefined) {
        const [owner = '', repo = ''] = payload.repo.split('/');
        statusComment = deps.createStatusComment({
          octokit,
          owner,
          repo,
          commentId: payload.status_comment_id,
          region: env.region,
          summarizerModelId: env.summarizerModelId,
          summarizerFallbackModelId: env.summarizerFallbackModelId,
          mantleRegion: env.mantleRegion,
          reasoningEffort: env.reasoningEffort,
          isFallback: useFallback,
        });
        await statusComment.open();
      }

      yield { event: 'status', data: { phase: 'workspace' } };
      const prepared = await deps.prepareWorkspace(payload, octokit, tokens, {
        workspaceRoot: env.workspaceRoot,
        appId: Number(env.githubAppId),
        upstreamRepo: env.upstreamRepo,
      });
      if ('skipped' in prepared) {
        // Nothing to review: post nothing and leave the state comment
        // alone. Completed, so the invoker does not run it again.
        console.log(`[invoke] automatic review (trigger=${payload.trigger}) of ${payload.repo}#${payload.pr_number} not run: ${prepared.skipped}; nothing posted`);
        await heartbeat.finish('completed');
        yield {
          event: 'done',
          data: {
            status: 'completed',
            repo: payload.repo,
            pr_number: payload.pr_number,
            head_sha: prepared.headSha,
            terminal_tool: null,
            decision: 'skipped',
            skip_reason: prepared.skipped,
          },
        };
        return;
      }
      const ctx = prepared;

      // Graduated skills: patterns that crossed the reinforcement
      // threshold and were published by the curator. They go into the
      // system prompt next to the baked-in skill. Concerns below the
      // threshold stay with the curator and never reach the reviewer.
      let systemPrompt = opts.systemPrompt;
      if (env.skillsRegistryId) {
        yield { event: 'status', data: { phase: 'graduated_skills' } };
        const grads = await deps.loadGraduatedSkills({
          registryId: env.skillsRegistryId,
          region: env.region,
        });
        if (grads.length > 0) systemPrompt = `${opts.systemPrompt}\n\n${renderGraduatedSkills(grads)}`;
        yield { event: 'status', data: { phase: 'graduated_skills_loaded', count: grads.length } };
      }

      yield { event: 'status', data: { phase: 'tools' } };
      const syncReadyLabel = env.readyLabelFunction
        ? createReadyLabelInvoker({
            functionName: env.readyLabelFunction,
            region: env.region,
            installationId: payload.installation_id,
            repo: payload.repo,
            prNumber: payload.pr_number,
          })
        : undefined;
      const tools = await assembleTools({
        ctx,
        octokit,
        tokens,
        allowWrite: env.allowWrite,
        env,
        statusComment,
        onTerminal,
        syncReadyLabel,
      });
      if (!isTerminalCallbackWired(onTerminal)) {
        throw new Error('assembleTools did not pass onTerminal to assembleCommonTools, so the run could not tell when the review is done');
      }

      yield { event: 'status', data: { phase: 'review', pr: `${ctx.owner}/${ctx.repo}#${ctx.prNumber}` } };
      const callLimit = new ModelCallLimit(env.maxIterations);
      const agent = new Agent({
        model,
        systemPrompt,
        tools: toToolList(tools),
        retryStrategy: new StreamStallRetryStrategy(() => terminal.tool !== null),
        conversationManager: new ReviewConversationManager(env.maxIterations + TERMINAL_RETRY_CALLS),
      });
      callLimit.attach(agent);
      // Beat on agent activity, not only on relayed frames. If the SSE
      // consumer closes the stream, the review goes on without relaying
      // events; the run must not look dead to the watchdog while it is
      // still working toward a terminal tool.
      agent.addHook(BeforeModelCallEvent, () => heartbeat.beat());
      agent.addHook(AfterToolCallEvent, () => heartbeat.beat());

      const userMessage = [
        renderPrOverview(ctx),
        ...(payload.status_comment_id !== undefined ? mentionBlock(payload) : []),
        '',
        '---',
        '',
        'The workspace is checked out at the PR head. Start from Phase 1 of the reviewer system prompt. When you have completed your review, call either `post_review` (with findings) or `skip_review` (with reason). Do not return text to the user; communicate only through tool calls.',
      ].join('\n');

      // Text of the latest model call, for the run summary.
      let finalText = '';
      const handleAgentEvent = (event: AgentStreamEvent): RunEvent | null => {
        heartbeat.beat();
        if (event.type === 'beforeModelCallEvent') {
          finalText = '';
          return null;
        }
        const text = textDelta(event);
        if (text !== null) {
          finalText += text;
          return { event: 'message', data: { text } };
        }
        if (event.type === 'beforeToolCallEvent') {
          const { name, input } = event.toolUse;
          let inputHint = '';
          try { inputHint = JSON.stringify(input ?? {}).slice(0, 200); } catch { /* unserializable input */ }
          // Tool inputs in the runtime log show where a review spent
          // its effort, e.g. how many git calls went to the backport check.
          console.log(`[tool] ${name} ${inputHint}`);
          statusComment?.note(`${name} ${inputHint}`);
          return { event: 'tool_use', data: { name } };
        }
        return null;
      };

      // The model turns: the review, then the terminal-retry prompt if
      // the review ended without a terminal tool.
      const turns = async function* (): AsyncGenerator<RunEvent, void, undefined> {
        try {
          for await (const event of agent.stream(userMessage)) {
            const outgoing = handleAgentEvent(event);
            if (outgoing) yield outgoing;
          }
          if (terminal.tool === null) {
            if (callLimit.reached) console.warn(`[stream] model call limit (${env.maxIterations}) reached without a terminal tool`);
            callLimit.reserve(TERMINAL_RETRY_CALLS);
            yield { event: 'status', data: { phase: 'terminal_retry' } };
            for await (const event of agent.stream(TERMINAL_RETRY_MESSAGE)) {
              const outgoing = handleAgentEvent(event);
              if (outgoing) yield outgoing;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (terminal.tool === null) {
            console.error(`[stream] unhandled error before a terminal tool: ${msg}`);
            throw err;
          }
          // The terminal tool has done its work, so the review is
          // complete. Failing the run now would make the invoker
          // redeliver it and post a second review. The usual case is a
          // model that ends its stream without a closing message right
          // after the terminal call.
          console.warn(`[stream] error after terminal tool ${terminal.tool}; treating the run as completed: ${msg}`);
        }
      };

      // A review outlives the 15-minute worker that started it, so a
      // closed stream must not stop it. The frames are relayed by hand,
      // not with for await or yield*, so that closing this generator does
      // not close the turns or the agent stream under them. If the
      // consumer closes it mid-review, the finally runs the turns to the
      // end without relaying anything; for turns that already ended,
      // next() returns done at once.
      const review = turns();
      // True once the relay loop ends by itself, by finishing or by an
      // error turns() has logged. False means the consumer closed it.
      let relayEnded = false;
      try {
        for (let r = await review.next(); !r.done; r = await review.next()) yield r.value;
        relayEnded = true;
      } catch (err) {
        relayEnded = true;
        throw err;
      } finally {
        try {
          let r = await review.next();
          if (!r.done) console.warn('[stream] stream closed during the review; finishing it without relaying frames');
          while (!r.done) r = await review.next();
          // After a close, the error below this finally never runs, so
          // log what it would have said.
          if (!relayEnded && terminal.tool === null) {
            console.error(`[stream] review ended without a terminal tool; model_calls=${callLimit.used} final_text_preview=${finalText.slice(0, 400)}`);
          }
        } catch {
          // turns() has logged the error, and the finally below records
          // the run as failed.
        }
      }

      if (terminal.tool === null) {
        throw new Error(`review completed without terminal tool; model_calls=${callLimit.used} final_text_preview=${finalText.slice(0, 400)}`);
      }

      // onTerminal started this write; wait for it before reporting done.
      await heartbeat.finish('completed');

      yield {
        event: 'done',
        data: {
          status: 'completed',
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: ctx.headSha,
          terminal_tool: terminal.tool,
          terminal_result: terminal.result.slice(0, 600),
          model_calls: callLimit.used,
          final_text_preview: finalText.slice(0, 400),
        },
      };
    } finally {
      statusComment?.stop();
      // A no-op once the outcome is recorded. Any other exit, including
      // an early close, is recorded as completed if a terminal tool
      // succeeded and as failed if not.
      await heartbeat.finish(terminal.tool !== null ? 'completed' : 'failed');
    }
  };
}

/** The part of BedrockAgentCoreApp that decides what /ping reports. */
export type AsyncTaskTracker = Pick<BedrockAgentCoreApp, 'addAsyncTask' | 'completeAsyncTask'>;

/**
 * Relays a run's frames with the run registered as an async task on the
 * app, so the runtime's /ping reports HealthyBusy until the run ends.
 * AgentCore stops a session that reports Healthy for 15 minutes, and a
 * review goes on after the worker that started it has disconnected.
 */
export async function* asBusyTask<T>(app: AsyncTaskTracker, name: string, frames: AsyncGenerator<T, void, unknown>): AsyncGenerator<T, void, unknown> {
  const task = app.addAsyncTask(name);
  try {
    // yield* passes a close on to frames and waits for it to finish.
    yield* frames;
  } finally {
    app.completeAsyncTask(task);
  }
}

/**
 * The reviewer prompt followed by the baked-in skill. A release check
 * proposes repo skill changes by pull request in suppress-and-add form,
 * so once one merges the skill holds suppression markers; they become
 * the same labels graduated skills get.
 */
export function baseSystemPrompt(promptMd: string, skillMd: string): string {
  return `${promptMd}\n\n---\n\n## Skill: institutional memory\n\n${labelSuppressedPieces(skillMd)}`;
}

export async function bootstrap(config: RunAgentConfig): Promise<void> {
  const env = loadEnv();
  const { prompt: PROMPT_MD, skill: SKILL_MD } = await loadAssets(env);
  const systemPrompt = baseSystemPrompt(PROMPT_MD, SKILL_MD);

  console.log(`[boot] model=${env.modelId} fallback=${env.fallbackModelId} region=${env.region} bucket=${env.assetsBucket}`);

  const review = createReviewHandler({ env, systemPrompt, assembleTools: config.assembleTools });
  const app: BedrockAgentCoreApp = new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema,
      process: (payload: Payload) => asBusyTask(app, 'review', review(payload)),
    },
  });

  app.run();
}
