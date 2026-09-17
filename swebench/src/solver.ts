/**
 * The agentic solve loop for a single SWE-bench instance.
 *
 * Wiring (the requested workflow, end to end):
 *   - /learn-codebase priming is built from the checkout and injected into the
 *     system prompt (buildCodebaseMap → renderPrimingBlock → buildPrompt).
 *   - mem_* recall tools are offered alongside bash/submit, and the prompt
 *     instructs the model to consult claude-mem memory before editing.
 *   - The model drives a tool loop; when it submits (or stops), we capture the
 *     working-tree diff as the candidate patch.
 */
import type { ChatMessage, ChatProvider, SolveResult, ToolCall, ToolDefinition, TokenUsage } from './types.ts';
import type { SweBenchInstance } from './types.ts';
import { addUsage, emptyUsage } from './openrouter.ts';
import { agentToolDefinitions, runBashTool, BASH_TOOL, SUBMIT_TOOL } from './agent-tools.ts';
import { MemSearchClient, dispatchMemTool, isMemTool, memSearchToolDefinitions } from './mem-tools.ts';
import { buildPrompt } from './prompt.ts';
import { primeFromRepo, type LearnOptions } from './learn.ts';
import { extractPatch } from './repo.ts';

export interface SolveOptions {
  instance: SweBenchInstance;
  repoDir: string;
  provider: ChatProvider;
  /** When present, mem_* tools are offered and their calls dispatched here. */
  memClient?: MemSearchClient;
  /** Skip /learn-codebase priming (faster, less context). Default false. */
  skipPriming?: boolean;
  learnOptions?: LearnOptions;
  maxTurns?: number;
  bashTimeoutMs?: number;
  /** Abort the whole solve (e.g. global wall-clock budget). */
  signal?: AbortSignal;
  /** Progress sink for CLI logging. */
  onEvent?: (event: SolveEvent) => void;
}

export type SolveEvent =
  | { type: 'priming'; filesRead: number; filesSeen: number; dropped: number }
  | { type: 'turn'; index: number; toolCalls: number }
  | { type: 'tool'; name: string; ok: boolean }
  | { type: 'submit'; notes?: string }
  | { type: 'done'; patchBytes: number };

const MAX_TOOL_RESULT_CHARS = 24_000;

export async function solveInstance(opts: SolveOptions): Promise<SolveResult> {
  const { instance, repoDir, provider } = opts;
  const startedAt = Date.now();
  const maxTurns = opts.maxTurns ?? 40;
  const toolCallCounts: Record<string, number> = {};
  let memSearchCalls = 0;
  let usage: TokenUsage = emptyUsage();
  let error: string | undefined;

  // 1. /learn-codebase priming.
  let primingBlock = '';
  if (!opts.skipPriming) {
    const { map, block } = primeFromRepo(repoDir, opts.learnOptions);
    primingBlock = block;
    opts.onEvent?.({ type: 'priming', filesRead: map.totalFilesRead, filesSeen: map.totalFilesSeen, dropped: map.droppedForBudget });
  }

  const { system, user } = buildPrompt(instance, primingBlock);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const tools: ToolDefinition[] = [
    ...agentToolDefinitions(),
    ...(opts.memClient ? memSearchToolDefinitions() : []),
  ];

  let submitted = false;
  let submitNotes: string | undefined;
  let turns = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (opts.signal?.aborted) {
        error = 'aborted';
        break;
      }
      turns = turn + 1;
      const completion = await provider.complete({ messages, tools, signal: opts.signal });
      usage = addUsage(usage, completion.usage);
      const assistant = completion.message;
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      opts.onEvent?.({ type: 'turn', index: turns, toolCalls: calls.length });

      if (calls.length === 0) {
        // Natural stop with no tool call — the model is done (or refusing).
        break;
      }

      for (const call of calls) {
        const name = call.function.name;
        toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
        if (isMemTool(name)) memSearchCalls++;

        const { text, ok } = await executeToolCall(call, {
          repoDir,
          memClient: opts.memClient,
          bashTimeoutMs: opts.bashTimeoutMs,
        });
        opts.onEvent?.({ type: 'tool', name, ok });

        if (name === SUBMIT_TOOL) {
          submitted = true;
          submitNotes = parseArgs(call).notes as string | undefined;
          opts.onEvent?.({ type: 'submit', notes: submitNotes });
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: text.length > MAX_TOOL_RESULT_CHARS ? text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]' : text,
        });
      }

      if (submitted) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const patch = await extractPatch(repoDir).catch((e) => {
    if (!error) error = e instanceof Error ? e.message : String(e);
    return '';
  });

  opts.onEvent?.({ type: 'done', patchBytes: Buffer.byteLength(patch, 'utf-8') });

  return {
    instance_id: instance.instance_id,
    patch,
    succeeded: patch.trim().length > 0 && !error,
    turns,
    toolCallCounts,
    memSearchCalls,
    usage,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  };
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function executeToolCall(
  call: ToolCall,
  ctx: { repoDir: string; memClient?: MemSearchClient; bashTimeoutMs?: number },
): Promise<{ text: string; ok: boolean }> {
  const name = call.function.name;
  const args = parseArgs(call);

  try {
    if (name === BASH_TOOL) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command) return { text: 'Error: bash requires a "command" string.', ok: false };
      return { text: await runBashTool(command, ctx.repoDir, ctx.bashTimeoutMs), ok: true };
    }
    if (name === SUBMIT_TOOL) {
      return { text: 'Submission received. The current working-tree diff will be graded.', ok: true };
    }
    if (isMemTool(name)) {
      if (!ctx.memClient) return { text: 'mem-search is not available in this run.', ok: false };
      return { text: await dispatchMemTool(name, args, ctx.memClient), ok: true };
    }
    return { text: `Error: unknown tool "${name}".`, ok: false };
  } catch (err) {
    return { text: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}
