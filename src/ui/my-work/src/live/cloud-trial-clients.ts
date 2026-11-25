import { CMEM_MCP_URL, SETUP_TOOLS } from '../setup/agent-connections.ts'
import { interpolate } from '../../../i18n/locale.ts'

export interface TrialClient {
  id: string
  name: string
  surface?: string
  setup: string
  commands?: string[]
  open?: string
  settings?: string
  guide?: string
  availability?: string
}

const GEMINI_WEB_SETUP = 'In Gemini on the web, open Connected Apps ({settings}) → Custom apps. Add {url}, sign in to the same Claude-Mem account, then select the app with @ in your chat.'
const CLI_SETUP = 'Run {command} and then {login} in your terminal. Sign in to the same Claude-Mem account when prompted.'
const GEMINI_CLI_SETUP = 'Run {command} in your terminal. Open Gemini CLI, run /mcp auth cmem, and sign in to the same Claude-Mem account.'

/** Use the same public endpoint, commands and documentation the local installer's Finish Setup offers. */
function installedClient(id: string, fallback: string, override: Partial<TrialClient> = {}): TrialClient {
  const source = SETUP_TOOLS.find(tool => tool.id === id)
  if (!source) throw new Error('Unknown setup tool: ' + id)
  return { id, name: source.name, setup: fallback, commands: source.commands, guide: source.guide?.href, ...override }
}

export const PRIMARY_TRIAL_CLIENTS: readonly TrialClient[] = [
  installedClient('chatgpt', 'Open ChatGPT Plugins ({settings}), add {url} as a custom MCP server with OAuth, and sign in to the same Claude-Mem account. Install the plugin and select it with @ in your chat.', { open: 'https://chatgpt.com/', settings: 'https://chatgpt.com/plugins', surface: 'ChatGPT Work' }),
  installedClient('claude-ai', 'In Claude, open Plugins or Customize → Connectors. Add a custom connector with {url}, sign in to the same Claude-Mem account, and enable the connector in your conversation.', { name: 'Claude', surface: 'Claude Cowork', open: 'https://claude.ai/' }),
  { id: 'gemini-web', name: 'Gemini', surface: 'Gemini web', setup: GEMINI_WEB_SETUP, open: 'https://gemini.google.com/app', settings: 'https://gemini.google.com/apps', guide: 'https://support.google.com/gemini/answer/17209137',
    availability: 'Gemini custom apps require an eligible personal Google account in the US, age 18+, English, and Gemini conversation history turned on.' },
]

export const OTHER_TRIAL_CLIENTS: readonly TrialClient[] = [
  installedClient('gemini-cli', GEMINI_CLI_SETUP),
  installedClient('claude-code', CLI_SETUP),
  installedClient('codex', CLI_SETUP),
  { id: 'other-mcp', name: 'Other MCP agent', setup: 'Open the agent’s remote MCP settings, add {url} over HTTP, and sign in to the same Claude-Mem account with OAuth.' },
]

/** A clipboard item is ready to paste in a conversation even when the user has never connected that client. */
export function clientSetupInstructions(client: TrialClient, translate: (source: string) => string) {
  return interpolate(translate(client.setup), { url: CMEM_MCP_URL, settings: client.settings ?? '', command: client.commands?.[0] ?? '', login: client.commands?.[1] ?? '' })
}

export function clientHandoffPrompt(client: TrialClient, task: string, translate: (source: string) => string) {
  return translate(task) + '\n\n' + interpolate(translate('If you cannot access Claude-Mem tools here, help me connect first. {setup} Wait for me to authorize the connection, then retry.'), {
    setup: clientSetupInstructions(client, translate),
  })
}
