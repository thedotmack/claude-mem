export interface ObservationSourceMetadata {
  tool_name: string;
  source_url?: string;
  search_query?: string;
  command?: string;
  file_path?: string;
  glob_pattern?: string;
  search_pattern?: string;
  search_path?: string;
  subagent_type?: string;
  lsp_operation?: string;
}

export function extractSourceMetadata(
  toolName: string,
  toolInput: unknown
): ObservationSourceMetadata {
  const metadata: ObservationSourceMetadata = { tool_name: toolName };

  let input: Record<string, unknown> = {};
  if (typeof toolInput === 'string') {
    try { input = JSON.parse(toolInput); } catch { /* leave empty */ }
  } else if (toolInput && typeof toolInput === 'object') {
    input = toolInput as Record<string, unknown>;
  }

  switch (toolName) {
    case 'WebFetch':
      if (typeof input.url === 'string') metadata.source_url = input.url;
      break;
    case 'WebSearch':
      if (typeof input.query === 'string') metadata.search_query = input.query;
      break;
    case 'Bash':
      if (typeof input.command === 'string') metadata.command = input.command;
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
      if (typeof input.file_path === 'string') metadata.file_path = input.file_path;
      break;
    case 'NotebookEdit':
      if (typeof input.notebook_path === 'string') metadata.file_path = input.notebook_path;
      break;
    case 'Glob':
      if (typeof input.pattern === 'string') metadata.glob_pattern = input.pattern;
      break;
    case 'Grep':
      if (typeof input.pattern === 'string') metadata.search_pattern = input.pattern;
      if (typeof input.path === 'string') metadata.search_path = input.path;
      break;
    case 'Task':
      if (typeof input.subagent_type === 'string') metadata.subagent_type = input.subagent_type;
      break;
    case 'LSP':
      if (typeof input.operation === 'string') metadata.lsp_operation = input.operation;
      break;
    default:
      if (typeof input.url === 'string') metadata.source_url = input.url;
      break;
  }

  return metadata;
}
