import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const WORKER_URL = "http://localhost:37777"

// Helper to extract session ID from various event shapes
const getSessionID = (event: any): string | undefined => {
  return event.properties?.info?.id ||
         event.properties?.sessionID ||
         event.session?.id ||
         (event as any).session_id
}

export const ClaudeMemPlugin: Plugin = async ({ client, directory }) => {
  const projectName = directory.split('/').pop() || 'unknown'

  // Helper for POST requests to claude-mem worker API
  async function postWorker(endpoint: string, body: object): Promise<any> {
    try {
      const res = await fetch(`${WORKER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      return res.ok ? await res.json() : null
    } catch {
      return null // Worker not running
    }
  }

  // Helper for GET requests to claude-mem worker API
  async function getWorker(endpoint: string, params: Record<string, string>): Promise<any> {
    try {
      const query = new URLSearchParams(params).toString()
      const res = await fetch(`${WORKER_URL}${endpoint}?${query}`)
      return res.ok ? await res.json().catch(() => res.text()) : null
    } catch {
      return null // Worker not running
    }
  }

  // Inject context into session
  async function injectContext(sessionId: string): Promise<void> {
    // /api/context/inject is a GET endpoint
    const contextText = await getWorker('/api/context/inject', {
      projects: projectName
    })
    if (contextText && typeof contextText === 'string' && contextText.trim()) {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [{ type: "text", text: contextText, synthetic: true }]
        }
      })
    }
  }

  return {
    // Memory search tools
    tool: {
      mem_search: tool({
        description: "Search claude-mem memory for past observations",
        args: {
          query: tool.schema.string().describe("Search query")
        },
        async execute(args, ctx) {
          // /api/search is a GET endpoint
          const result = await getWorker('/api/search', {
            query: args.query,
            project: projectName,
            format: 'index',
            limit: '20'
          })
          return result ? JSON.stringify(result, null, 2) : "No results found"
        }
      })
    },

    // Event handlers
    event: async ({ event }) => {
      const sessionId = getSessionID(event)
      if (!sessionId) return

      if (event.type === 'session.created') {
        await postWorker('/api/sessions/init', {
          sessionId,
          cwd: directory,
          project: projectName
        })
        await injectContext(sessionId)
      }

      if (event.type === 'session.compacted') {
        // Re-inject context after compaction
        await injectContext(sessionId)
      }
    },

    // Capture tool observations
    "tool.execute.after": async (input, output) => {
      await postWorker('/api/sessions/observations', {
        sessionId: input.sessionID,
        cwd: directory,
        toolName: input.tool,
        toolInput: output.metadata,
        toolOutput: output.output
      })
    }
  }
}
