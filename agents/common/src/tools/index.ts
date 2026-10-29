import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import type { StatusComment } from '../status-comment.js';
import type { TokenSource } from '../github-auth.js';
import { createStateCommentWriter } from '../review-state.js';
import { buildHarnessTools } from './harness.js';
import { buildGitTool } from './git.js';
import { buildGhApiReadTool, buildPostReviewTool, buildSkipTool, createTerminalGate, type GhToolsDeps, type TerminalToolName } from './gh.js';

export interface CommonToolsOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly tokens: TokenSource;
  readonly allowWrite?: boolean;
  readonly statusComment?: StatusComment;
  /**
   * Called once, when post_review or skip_review succeeds. The run loop
   * relies on it to know the review is done; pass through the
   * `onTerminal` from AssembleBaseOpts.
   */
  readonly onTerminal?: (tool: TerminalToolName, result: string) => void;
  /** After a successful state write; pass through from AssembleBaseOpts. */
  readonly syncReadyLabel?: () => Promise<void>;
}

/**
 * Build the review-agent-agnostic tool set: harness read/grep/glob/lsp
 * (+ write/edit when allowed), read-only git, GitHub REST read, and
 * post_review / skip_review.
 *
 * Per-agent code composes this with its own build/run tools (make for valkey;
 * cargo/mvn/pytest/... for valkey-glide) before handing to Strands.
 */
export async function assembleCommonTools(opts: CommonToolsOpts): Promise<readonly unknown[]> {
  const harness = await buildHarnessTools({
    workspaceRoot: opts.ctx.workspacePath,
    allowWrite: opts.allowWrite ?? false,
  });

  const ghDeps: GhToolsDeps = {
    ctx: opts.ctx,
    octokit: opts.octokit,
    tokens: opts.tokens,
    statusComment: opts.statusComment,
    stateWriter: createStateCommentWriter(opts.octokit, opts.ctx),
    terminalGate: createTerminalGate(opts.onTerminal),
    syncReadyLabel: opts.syncReadyLabel,
  };

  return [
    ...harness.tools,
    buildGitTool({ workspaceRoot: opts.ctx.workspacePath }),
    buildGhApiReadTool(ghDeps),
    buildPostReviewTool(ghDeps),
    buildSkipTool(ghDeps),
  ];
}

// Re-exports so agents can import everything through the common barrel.
export { buildHarnessTools } from './harness.js';
export { buildGitTool } from './git.js';
export { buildGhApiReadTool, buildPostReviewTool, buildSkipTool, createTerminalGate } from './gh.js';
export type { GhToolsDeps, TerminalGate, TerminalToolName } from './gh.js';
