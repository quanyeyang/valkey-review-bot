import { assembleCommonTools } from '../../../common/src/tools/index.js';
import type { AssembleBaseOpts } from '../../../common/src/run-agent.js';
import { buildMakeTool } from './make.js';
import { buildToolEnabled } from './make-policy.js';

/**
 * valkey-review tool set: the common tools plus, when ALLOW_BUILD is set,
 * a make wrapper limited to compile and unit-test targets in the checkout.
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
    extras.push(buildMakeTool({ workspaceRoot: opts.ctx.workspacePath }));
  }

  return [...common, ...extras];
}
