export const CMEM_MCP_URL = 'https://cmem.ai/api/mcp'

/** Finish Setup tools. Names, descriptions and steps come from the PROTO workspace tool list and CONNECTOR-EVIDENCE.md. */
export interface SetupTool {
  id: string
  name: string
  /** Local tools capture work on this machine; cloud readers only exist with On The Go. */
  kind: 'local' | 'cloud'
  /** Already configured by the install step; shown as connected in Finish Setup. */
  installed?: boolean
  steps?: string[]
  commands?: string[]
  guide?: { href: string; label: string }
}
export const SETUP_TOOLS: SetupTool[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'local', commands: ['claude mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', 'claude mcp login cmem', 'claude mcp list'], guide: { href: 'https://code.claude.com/docs/en/mcp', label: 'Claude Code connection guide' } },
  { id: 'claude-ai', name: 'Claude.ai', kind: 'cloud', steps: ['Open Customize, then Connectors, and choose + Add.', 'Choose Add custom connector, name it CMEM, paste the URL, and continue.', 'Complete the OAuth sign-in and add the connector. Enable it in a chat from +, then Connectors.'], guide: { href: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', label: 'Claude connection guide' } },
  { id: 'codex', name: 'Codex CLI', kind: 'local', commands: ['codex mcp add cmem --url https://cmem.ai/api/mcp', 'codex mcp login cmem', 'codex mcp list'], guide: { href: 'https://learn.chatgpt.com/docs/extend/mcp', label: 'Codex connection guide' } },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'cloud', steps: ['Add CMEM as a remote HTTP MCP server.', 'Authenticate CMEM inside Gemini CLI, then check the available tools.'], commands: ['gemini mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', '/mcp auth cmem', '/mcp list'], guide: { href: 'https://geminicli.com/docs/tools/mcp-server/', label: 'Gemini CLI connection guide' } },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'cloud', steps: ['Open ChatGPT Plugins and choose +, then Add custom MCP server.', 'Paste the CMEM URL, choose OAuth, and create the plugin.', 'Review the available tools, install the plugin, then @mention it in a chat.'], guide: { href: 'https://developers.openai.com/plugins/deploy/connect-chatgpt', label: 'ChatGPT connection guide' } },
]

