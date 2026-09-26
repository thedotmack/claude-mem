/**
 * The agent's own action tools: `bash` (scoped to the instance checkout) and
 * `submit` (signals the patch is ready). Combined with the mem_* recall tools,
 * these are everything the solver can do. Kept deliberately minimal — a
 * bash-only scaffold in the spirit of mini-swe-agent, plus explicit submission.
 */
import { runShell } from './exec.ts';
import type { ToolDefinition } from './types.ts';

export const SUBMIT_TOOL = 'submit';
export const BASH_TOOL = 'bash';

export function agentToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: BASH_TOOL,
        description:
          'Run a bash command in the repository checkout. Use it to explore code (grep/find/sed/cat), run the failing tests, and apply your fix (write files with a heredoc, sed, or python). State does NOT persist between calls except filesystem changes — always cd from the repo root within a single command if needed. Output is truncated at 64 KiB.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute from the repository root.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: SUBMIT_TOOL,
        description:
          'Call this once your edits to the working tree fully resolve the issue. The harness will capture `git diff` as your patch. Do not include changes to test files — grading applies the official tests separately.',
        parameters: {
          type: 'object',
          properties: {
            notes: { type: 'string', description: 'Optional one-line summary of the fix.' },
          },
          additionalProperties: false,
        },
      },
    },
  ];
}

/** Execute a bash tool call inside the repo dir. Returns text for the model. */
export async function runBashTool(command: string, cwd: string, timeoutMs = 120_000): Promise<string> {
  const res = await runShell(command, { cwd, timeoutMs });
  const parts: string[] = [];
  if (res.stdout) parts.push(res.stdout);
  if (res.stderr) parts.push(`[stderr]\n${res.stderr}`);
  if (res.timedOut) parts.push(`[command timed out after ${timeoutMs}ms and was killed]`);
  parts.push(`[exit code: ${res.code ?? 'null'}]`);
  return parts.join('\n');
}
