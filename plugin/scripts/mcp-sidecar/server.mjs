#!/usr/bin/env bun
// claude-mem MCP sidecar — exposes Resources + Prompts that complement the main
// claude-mem MCP server (which exposes only Tools).
//
// Spec: docs/sprint2/05-mcp-resources-prompts.md + docs/sprint2/07-tdd-plan-v2.md Phase 5.
//
// Register in ~/.claude/settings.json (or project .mcp.json):
//   "mcpServers": {
//     "claude-mem-sidecar": {
//       "type": "stdio",
//       "command": "bun",
//       "args": ["<path>/work/src/mcp-sidecar/server.mjs"]
//     }
//   }
//
// Requires: `cd work/src/mcp-sidecar && npm install` first (SDK dependency).

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
const DB_PATH = join(DATA_DIR, "claude-mem.db");

if (!existsSync(DB_PATH)) {
  process.stderr.write(`[sidecar] no claude-mem DB at ${DB_PATH}\n`);
  process.exit(2);
}
const db = new Database(DB_PATH, { readonly: true });

const server = new McpServer(
  { name: "claude-mem-sidecar", version: "0.1.0" },
  { capabilities: { resources: { listChanged: false }, prompts: { listChanged: false } } }
);

// ─── R1 — observations/{project} ──────────────────────────────────────────────
server.registerResource(
  "Project Observations",
  new ResourceTemplate("claude-mem://observations/{project}", {
    list: async () => {
      const rows = db.prepare(
        "SELECT project, COUNT(*) AS n FROM observations GROUP BY project ORDER BY n DESC LIMIT 20"
      ).all();
      return {
        resources: rows.map(r => ({
          uri: `claude-mem://observations/${r.project}`,
          name: `Observations: ${r.project} (${r.n})`,
          mimeType: "application/json",
          description: `Paginated observation feed for ${r.project}`,
        })),
      };
    },
  }),
  { mimeType: "application/json", description: "Paginated observation feed for a project." },
  async (uri, { project }) => {
    const rows = db.prepare(
      `SELECT id, type, title, subtitle, narrative, text, created_at, prompt_number
       FROM observations WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 200`
    ).all(project);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rows) }] };
  }
);

// ─── R2 — observations/{id} ───────────────────────────────────────────────────
server.registerResource(
  "Observation",
  new ResourceTemplate("claude-mem://observation/{id}", { list: undefined }),
  { mimeType: "application/json" },
  async (uri, { id }) => {
    const row = db.prepare("SELECT * FROM observations WHERE id = ?").get(parseInt(id, 10));
    if (!row) throw { code: -32002, message: "Resource not found", data: { uri: uri.href } };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(row) }] };
  }
);

// ─── R3 — sessions/{session_id} ───────────────────────────────────────────────
server.registerResource(
  "Session Bundle",
  new ResourceTemplate("claude-mem://sessions/{session_id}", { list: undefined }),
  { mimeType: "text/markdown" },
  async (uri, { session_id }) => {
    const sess = db.prepare(
      "SELECT * FROM sdk_sessions WHERE memory_session_id = ? OR content_session_id = ?"
    ).get(session_id, session_id);
    const obs = db.prepare(
      `SELECT type, title, narrative, text, created_at FROM observations
       WHERE memory_session_id = ? ORDER BY created_at_epoch`
    ).all(session_id);
    const md =
      `# Session ${session_id}\n\n` +
      (sess ? `Project: ${sess.project} · Started: ${sess.started_at}\n\n` : '') +
      obs.map(o => `## ${o.type} — ${o.title || ''}\n_${(o.created_at || '').slice(0,10)}_\n\n${o.narrative || o.text || ''}\n`).join('\n');
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
  }
);

// ─── R7 — stats ───────────────────────────────────────────────────────────────
server.registerResource(
  "claude-mem-stats",
  "claude-mem://stats",
  { mimeType: "application/json", description: "DB stats + worker health" },
  async (uri) => {
    const obs = db.prepare("SELECT COUNT(*) AS c FROM observations").get();
    const sessions = db.prepare("SELECT COUNT(*) AS c FROM sdk_sessions").get();
    const byType = db.prepare("SELECT type, COUNT(*) AS n FROM observations GROUP BY type ORDER BY n DESC").all();
    let workerPid = null;
    try {
      const pid = JSON.parse(readFileSync(join(DATA_DIR, 'worker.pid'), 'utf-8'));
      workerPid = pid.pid || null;
    } catch {}
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
      observations: obs.c, sessions: sessions.c, byType, workerPid,
      dbPath: DB_PATH,
    })}]};
  }
);

// ─── P1 — summarize-session ───────────────────────────────────────────────────
server.registerPrompt(
  "summarize-session",
  {
    title: "Summarize Session",
    description: "Build a markdown recap of a claude-mem session",
    argsSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    const obs = db.prepare(
      `SELECT type, title, narrative, text, created_at FROM observations
       WHERE memory_session_id = ? ORDER BY created_at_epoch`
    ).all(session_id);
    return { messages: [{ role: "user", content: { type: "text", text:
`Summarize session ${session_id} as markdown.
Sections: title, key decisions, files touched, next steps.

Observations (chronological):
${obs.map(o => `- [${o.type}] ${o.title || ''} — ${(o.narrative || o.text || '').slice(0,140)}`).join('\n')}`
    }}]};
  }
);

// ─── P2 — prep-handoff ────────────────────────────────────────────────────────
server.registerPrompt(
  "prep-handoff",
  {
    title: "Prepare Session Handoff",
    description: "Draft a session-handoff doc with focused recent decisions + open todos",
    argsSchema: { project: z.string(), focus: z.string().optional() },
  },
  async ({ project, focus }) => {
    const decisions = db.prepare(
      `SELECT title, narrative FROM observations WHERE project = ? AND type = 'decision'
       ORDER BY created_at_epoch DESC LIMIT 10`
    ).all(project);
    const changes = db.prepare(
      `SELECT title, narrative FROM observations WHERE project = ? AND type = 'change'
       ORDER BY created_at_epoch DESC LIMIT 10`
    ).all(project);
    return { messages: [{ role: "user", content: { type: "text", text:
`Prepare a handoff document for ${project}${focus ? ` focused on: ${focus}` : ''}.

Recent decisions:
${decisions.map(d => `- ${d.title}: ${(d.narrative||'').slice(0,140)}`).join('\n')}

Recent changes:
${changes.map(d => `- ${d.title}: ${(d.narrative||'').slice(0,140)}`).join('\n')}

Format as markdown: TL;DR, what's done, what's in flight, next step.`
    }}]};
  }
);

// ─── P3 — kb-question ─────────────────────────────────────────────────────────
server.registerPrompt(
  "kb-question",
  {
    title: "Ask claude-mem Knowledge Base",
    description: "Standardized RAG prompt that cites observations and hedges when evidence is thin",
    argsSchema: { question: z.string(), project: z.string().optional() },
  },
  ({ question, project }) => ({
    messages: [{ role: "user", content: { type: "text", text:
`You are answering from claude-mem persistent memory${project ? ` (project: ${project})` : ''}.
Question: ${question}

Workflow:
1. Use memory_search / search / query_corpus to find relevant observations.
2. Cite observation ids inline as [obs:<id>].
3. Hedge when evidence is thin ("I found 1 partial match…").
4. If the KB returns nothing relevant, say so and stop — do not fabricate.`
    }}],
  })
);

await server.connect(new StdioServerTransport());
process.stderr.write("[sidecar] connected on stdio\n");
