
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { spoolHookEvent } from '../spool-hook-event.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import { isServerClientError, type ServerRecordEventRequest } from '../../services/hooks/server-client.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { isToolSkipped } from '../../shared/is-tool-skipped.js';

/** The tool name a file edit is captured under, in both runtimes. */
const FILE_EDIT_TOOL_NAME = 'write_file';

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, filePath, edits } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      editCount: edits?.length ?? 0
    });

    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file edit observation', { cwd, filePath });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolInput = { filePath, edits };
    const toolResponse = { success: true };

    // The file edit is a write: in server runtime it must reach the server, not
    // a local hook spool no worker exists to drain (that silently dropped every
    // edit). Mirror observation.ts — record the event, and fall back to the
    // worker spool only when the failure is transient.
    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server') {
      // Worker ingest applies CLAUDE_MEM_SKIP_TOOLS; server events bypass it.
      if (isToolSkipped(FILE_EDIT_TOOL_NAME, loadFromFileOnce().CLAUDE_MEM_SKIP_TOOLS)) {
        logger.debug('HOOK', 'Server runtime: file edit excluded by CLAUDE_MEM_SKIP_TOOLS', { filePath });
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
      const event: ServerRecordEventRequest = {
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        platformSource,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: FILE_EDIT_TOOL_NAME,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          platformSource,
        },
      };
      try {
        await runtime.client.recordEvent(event);
        logger.debug('HOOK', 'File edit sent successfully via server', { filePath });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // fall through to the worker spool
        } else {
          logger.error('HOOK', 'Server file edit failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    spoolHookEvent('file_edit', {
      contentSessionId: sessionId,
      platformSource,
      toolName: FILE_EDIT_TOOL_NAME,
      toolInput,
      toolResponse,
      cwd,
    });

    logger.debug('HOOK', 'File edit observation spooled', { filePath });
    return { continue: true, suppressOutput: true };
  },
};
