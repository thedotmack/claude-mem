// Mechanical journal line for one tool event — no LLM, near-zero cost. The
// line answers "what happened" in a glance: which file, which command, did it
// fail. Anything richer belongs in the observation pipeline, not here.

const MAX_LINE_LENGTH = 120;

function truncate(text: string, max: number = MAX_LINE_LENGTH): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function stringField(input: unknown, ...names: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  for (const name of names) {
    const value = (input as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Best-effort failure detection over the PostToolUse tool_response, whose
 * shape varies by platform: an object with an exit-code-ish field, an
 * isError/interrupted flag, or a plain string in Claude Code's "Exit code N"
 * format. Unknown shapes are treated as success — a false negative only
 * drops the "failed:" marker, a false positive would poison the journal.
 */
function failureSuffix(toolResponse: unknown): string | null {
  if (toolResponse && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>;
    for (const name of ['exitCode', 'exit_code', 'returnCode', 'return_code']) {
      const code = response[name];
      if (typeof code === 'number' && code !== 0) return ` (exit ${code})`;
    }
    if (response.interrupted === true) return ' (interrupted)';
    if (response.isError === true || response.is_error === true) return ' (error)';
    return null;
  }
  if (typeof toolResponse === 'string') {
    const match = /^exit code (\d+)/i.exec(toolResponse.trim());
    if (match && match[1] !== '0') return ` (exit ${match[1]})`;
  }
  return null;
}

export function formatJournalLine(
  toolName: string,
  toolInput: unknown,
  toolResponse?: unknown,
): string {
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = stringField(toolInput, 'file_path', 'notebook_path', 'path');
      return truncate(path ? `${toolName} ${path}` : toolName);
    }
    case 'Glob':
    case 'Grep': {
      const pattern = stringField(toolInput, 'pattern');
      return truncate(pattern ? `${toolName} ${pattern}` : toolName);
    }
    case 'Bash': {
      const command = stringField(toolInput, 'command') ?? '';
      const failed = failureSuffix(toolResponse);
      const label = failed ? 'Bash failed:' : 'Bash:';
      return truncate(`${label} ${command}${failed ?? ''}`.trim());
    }
    case 'Task':
    case 'Agent': {
      const description = stringField(toolInput, 'description', 'prompt');
      return truncate(description ? `Agent: ${description}` : 'Agent');
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = stringField(toolInput, 'url', 'query');
      return truncate(target ? `${toolName} ${target}` : toolName);
    }
    default: {
      const summary = stringField(toolInput, 'file_path', 'path', 'command', 'pattern', 'query', 'url', 'description')
        ?? (toolInput !== undefined ? JSON.stringify(toolInput) : '');
      return truncate(summary ? `${toolName}: ${summary}` : toolName);
    }
  }
}
