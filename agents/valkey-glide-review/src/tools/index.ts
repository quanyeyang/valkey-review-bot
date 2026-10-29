import { assembleCommonTools } from '../../../common/src/tools/index.js';
import type { AssembleBaseOpts } from '../../../common/src/run-agent.js';
import { buildGlideBuildTool } from './build.js';
import { buildToolEnabled } from './build-policy.js';

/**
 * The common lsp tool starts clangd and nothing else. This image does not
 * install clangd, and there is no server for glide's languages, so every
 * lsp call would fail. The prompt sends the reviewer to grep instead.
 */
function isLspTool(t: unknown): boolean {
  return typeof t === 'object' && t !== null && (t as { name?: unknown }).name === 'lsp';
}

/**
 * valkey-glide-review tool set: the common tools without lsp, plus, when
 * ALLOW_BUILD is set, one build tool covering cargo, gradle, go, npm and
 * npx with allowlisted actions.
 */
export async function assembleTools(opts: AssembleBaseOpts): Promise<readonly unknown[]> {
  const common = await assembleCommonTools({
    ctx: opts.ctx,
    octokit: opts.octokit,
    tokens: opts.tokens,
    allowWrite: opts.allowWrite,
    statusComment: opts.statusComment,
    onTerminal: opts.onTerminal,
    syncReadyLabel: opts.syncReadyLabel,
  });

  const extras: unknown[] = [];
  if (buildToolEnabled(process.env)) {
    extras.push(buildGlideBuildTool({ workspaceRoot: opts.ctx.workspacePath }));
  }

  return [...common.filter((t) => !isLspTool(t)), ...extras];
}
