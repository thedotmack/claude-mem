// SPDX-License-Identifier: Apache-2.0

export type ObservationSkipReason =
  | 'meta_tool'
  | 'parallel_routine_read_only'
  | 'routine_read_only_command';

export interface ObservationFilterInput {
  toolName: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

const META_TOOL_NAMES = new Set([
  'mcp__serena__initial_instructions',
]);

const META_TOOL_PREFIXES = [
  'mcp__codegraph__',
];

const IMPORTANT_COMMAND_PATTERNS = [
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?(test|build|typecheck|lint|check)\b/i,
  /\b(bun|npm|pnpm|yarn)\s+test\b/i,
  /\b(cargo|go)\s+test\b/i,
  /\b(pytest|vitest|jest|tsc|eslint|biome|ruff)\b/i,
  /\bcubic\s+review\b/i,
  /\bgit\s+diff\s+--check\b/i,
];

const MUTATING_COMMAND_PATTERNS = [
  /\b(apply_patch|npm\s+(install|add|remove|update|audit\s+fix))\b/i,
  /\b(bun|pnpm|yarn)\s+(install|add|remove|update|upgrade)\b/i,
  /\bgit\s+(commit|push|merge|rebase|checkout|switch|reset|clean|pull|fetch|tag)\b/i,
  /(^|[;&|]\s*)sed\b[\s\S]*(\s-i\S*(?=\s|$)|--in-place(?:=\S*)?\b)/i,
  /(^|[;&|]\s*)find\b[\s\S]*(\s-delete\b|\s-exec\b|\s-execdir\b)/i,
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|chmod|chown|ln|tee)\b/i,
  /\bsqlite3\b[\s\S]*\b(insert|update|delete|create|drop|alter|replace)\b/i,
];

const READ_ONLY_COMMAND_PATTERNS = [
  /^(pwd|date|printf|echo)\b/i,
  /^(ls|find|rg|grep|sed|cat|nl|head|tail|wc|stat|jq|ps|pgrep|which|sort|uniq|cut|tr|awk)\b/i,
  /^command\s+-v\b/i,
];

const FAILURE_PATTERNS = [
  /\b(error|failed|failure|exception|traceback)\b/i,
  /\b(command not found|permission denied|no such file|exit code [1-9]\d*)\b/i,
  /"?exitCode"?\s*:\s*[1-9]/i,
  /\b(status|http)\s*[:=]?\s*[45]\d\d\b/i,
];

const STRING_RESPONSE_FAILURE_PATTERNS = [
  /(^|\n)\s*(command not found|command failed with exit code [1-9]\d*|command exited with code [1-9]\d*|permission denied|no such file|exit code [1-9]\d*|exited with code [1-9]\d*|process exited with code [1-9]\d*)\b/i,
  /(^|\n)\s*(traceback|uncaught exception)\b/i,
  /(^|\n)\s*(error|failed|failure|exception):/i,
  /(^|\n)\s*(bash|sh|zsh|fish):[^\n]*command not found/i,
  /(^|\n)\s*(curl|jq|rg|grep|sed|cat|tail|head|sqlite3|git|find|ls|awk):[^\n]*(error|failed|failure|parse error|could not|cannot|no such|permission denied)/i,
  /(^|\n)\s*(parse error|regex parse error|failed to (open|read|stat|access)|cannot (open|read|stat|access)|could not (open|read|stat|access))\b/i,
  /"?exitCode"?\s*:\s*[1-9]/i,
  /(^|\n)\s*(status|http)\s*[:=]?\s*[45]\d\d\b/i,
];

export function getObservationSkipReason(input: ObservationFilterInput): ObservationSkipReason | null {
  const toolName = input.toolName.trim();
  if (!toolName) return null;

  if (toolName === 'multi_tool_use.parallel') {
    return getParallelSkipReason(input.toolInput, input.toolResponse);
  }

  if (isMetaTool(toolName)) {
    return 'meta_tool';
  }

  if (toolName !== 'Bash' && toolName !== 'functions.exec_command' && toolName !== 'exec_command') {
    return null;
  }

  const command = extractBashCommand(input.toolInput);
  if (!command) {
    return null;
  }

  if (responseLooksLikeFailure(input.toolResponse)) {
    return null;
  }

  return isRoutineReadOnlyCommand(command) ? 'routine_read_only_command' : null;
}

export function isRoutineReadOnlyCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;

  if (IMPORTANT_COMMAND_PATTERNS.some(pattern => pattern.test(normalized))) {
    return false;
  }

  if (MUTATING_COMMAND_PATTERNS.some(pattern => pattern.test(normalized))) {
    return false;
  }

  if (hasNonDevNullOutputRedirect(normalized)) {
    return false;
  }

  const segments = splitShellCommand(normalized);
  if (segments.length > 1) {
    return segments.every(isRoutineReadOnlySimpleCommand);
  }

  return isRoutineReadOnlySimpleCommand(normalized);
}

function isRoutineReadOnlySimpleCommand(command: string): boolean {
  if (isReadOnlySqliteCommand(command)) {
    return true;
  }

  if (isLocalWorkerCurl(command)) {
    return true;
  }

  if (isReadOnlyGitCommand(command)) {
    return true;
  }

  return READ_ONLY_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

function isMetaTool(toolName: string): boolean {
  if (META_TOOL_NAMES.has(toolName)) return true;
  return META_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

function extractBashCommand(toolInput: unknown): string | null {
  if (typeof toolInput === 'string') {
    const trimmed = toolInput.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return extractBashCommand(parsed) ?? trimmed;
    } catch {
      return trimmed;
    }
  }

  if (toolInput && typeof toolInput === 'object' && 'command' in toolInput) {
    const command = (toolInput as { command?: unknown }).command;
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  }

  if (toolInput && typeof toolInput === 'object' && 'cmd' in toolInput) {
    const command = (toolInput as { cmd?: unknown }).cmd;
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  }

  return null;
}

function normalizeCommand(command: string): string {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function responseLooksLikeFailure(toolResponse: unknown): boolean {
  if (toolResponse === undefined || toolResponse === null) {
    return false;
  }

  if (typeof toolResponse === 'object') {
    const explicitStatus = getExplicitFailureStatus(toolResponse as Record<string, unknown>);
    if (explicitStatus !== null) {
      return explicitStatus;
    }

    const stderr = (toolResponse as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return FAILURE_PATTERNS.some(pattern => pattern.test(stderr));
    }

    return false;
  }

  const text = stringifyResponse(toolResponse).slice(0, 4000);
  return STRING_RESPONSE_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

function getExplicitFailureStatus(response: Record<string, unknown>): boolean | null {
  for (const field of ['exitCode', 'exit_code', 'code']) {
    const value = response[field];
    if (typeof value === 'number') {
      return value !== 0;
    }
  }

  for (const field of ['status', 'statusCode', 'httpStatus']) {
    const value = response[field];
    if (typeof value === 'number') {
      return value >= 400;
    }
  }

  return null;
}

function stringifyResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getParallelSkipReason(toolInput: unknown, toolResponse: unknown): ObservationSkipReason | null {
  if (responseLooksLikeFailure(toolResponse)) {
    return null;
  }

  const toolUses = extractParallelToolUses(toolInput);
  if (toolUses.length === 0) {
    return null;
  }

  const toolResponses = extractParallelToolResponses(toolResponse);

  return toolUses.every((toolUse, index) => {
    const reason = getObservationSkipReason({
      toolName: toolUse.toolName,
      toolInput: toolUse.toolInput,
      toolResponse: toolResponses[index],
    });
    return reason !== null;
  }) ? 'parallel_routine_read_only' : null;
}

function extractParallelToolUses(toolInput: unknown): Array<{ toolName: string; toolInput: unknown }> {
  if (typeof toolInput === 'string') {
    try {
      return extractParallelToolUses(JSON.parse(toolInput) as unknown);
    } catch {
      return [];
    }
  }

  if (!toolInput || typeof toolInput !== 'object') {
    return [];
  }

  const rawToolUses = (toolInput as { tool_uses?: unknown }).tool_uses;
  if (!Array.isArray(rawToolUses)) {
    return [];
  }

  return rawToolUses.flatMap(toolUse => {
    if (!toolUse || typeof toolUse !== 'object') {
      return [];
    }
    const record = toolUse as { recipient_name?: unknown; parameters?: unknown };
    if (typeof record.recipient_name !== 'string' || !record.recipient_name.trim()) {
      return [];
    }
    return [{
      toolName: record.recipient_name.trim(),
      toolInput: record.parameters,
    }];
  });
}

function extractParallelToolResponses(toolResponse: unknown): unknown[] {
  if (typeof toolResponse === 'string') {
    try {
      return extractParallelToolResponses(JSON.parse(toolResponse) as unknown);
    } catch {
      return [];
    }
  }

  if (Array.isArray(toolResponse)) {
    return toolResponse;
  }

  if (!toolResponse || typeof toolResponse !== 'object') {
    return [];
  }

  const record = toolResponse as Record<string, unknown>;
  for (const field of ['tool_responses', 'toolResponses', 'tool_results', 'toolResults', 'responses', 'results', 'outputs']) {
    const value = record[field];
    if (Array.isArray(value)) {
      return value.map(extractToolResponsePayload);
    }
  }

  const toolUses = record.tool_uses;
  if (Array.isArray(toolUses)) {
    return toolUses.map(extractToolResponsePayload);
  }

  return [];
}

function extractToolResponsePayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const field of ['toolResponse', 'tool_response', 'response', 'result', 'output', 'content']) {
    if (field in record) {
      return record[field];
    }
  }

  return value;
}

function splitShellCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if (char === ';' || char === '|') {
      pushSegment(segments, current);
      current = '';
      if ((char === '|' && next === '|')) {
        index++;
      }
      continue;
    }

    if (char === '&' && next === '&') {
      pushSegment(segments, current);
      current = '';
      index++;
      continue;
    }

    current += char;
  }

  pushSegment(segments, current);
  return segments;
}

function pushSegment(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed) {
    segments.push(trimmed);
  }
}

function hasNonDevNullOutputRedirect(command: string): boolean {
  const redirects = command.matchAll(/(?:^|[^<>=])\d*>>?\s*([^\s;&|]+)/g);
  for (const redirect of redirects) {
    const target = redirect[1]?.replace(/^['"]|['"]$/g, '') ?? '';
    if (target && !target.startsWith('&') && target !== '/dev/null') {
      return true;
    }
  }
  return false;
}

function isReadOnlySqliteCommand(command: string): boolean {
  if (!/^sqlite3\b/i.test(command)) return false;
  if (/\b(insert|update|delete|create|drop|alter|replace|vacuum|reindex)\b/i.test(command)) {
    return false;
  }
  return /\b(select|pragma)\b|['"]\.(tables|schema|indexes)\b/i.test(command);
}

function isLocalWorkerCurl(command: string): boolean {
  if (!/^curl\b/i.test(command)) return false;

  const methodMatch = /\s(?:-X|--request)\s*=?\s*['"]?([A-Z]+)/i.exec(command);
  const method = methodMatch?.[1]?.toUpperCase();
  if (method && method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  if (/\s(-d|--data(?:-[a-z-]+)?|--form(?:-[a-z-]+)?|--upload-file|-T)\b/i.test(command)) {
    return false;
  }

  return /https?:\/\/(127\.0\.0\.1|localhost):\d+\/api\/(context(?:\/inject)?|search(?:\/observations)?|observations|health|readiness|version|settings|logs|sessions\/processing)(?:[?#'")\s]|$)/i.test(command);
}

function isReadOnlyGitCommand(command: string): boolean {
  const withoutCwd = command.replace(/^git\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+/i, 'git ');
  return (
    /^git\s+(status|log|rev-parse)\b/i.test(withoutCwd) ||
    /^git\s+branch\s+(?:$|-a\b|-r\b|-v\b|-vv\b|--all\b|--remotes\b|--list\b|--show-current\b|--contains\b|--merged\b|--no-merged\b)/i.test(withoutCwd) ||
    /^git\s+remote\s+(?:$|-v\b|show\b|get-url\b)/i.test(withoutCwd) ||
    /^git\s+show\b.*--name-only\b/i.test(withoutCwd) ||
    /^git\s+diff\b.*--(stat|name-only|name-status)\b/i.test(withoutCwd)
  );
}
