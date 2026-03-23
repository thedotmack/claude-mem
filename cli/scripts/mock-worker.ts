#!/usr/bin/env bun
/**
 * Mock memory worker for testing cmem CLI without claude-mem installed.
 * Serves realistic fake data on port 37777.
 *
 * Usage: bun run scripts/mock-worker.ts
 */

const PORT = parseInt(process.env.CMEM_WORKER_PORT || '37777', 10);

const MOCK_OBSERVATIONS = [
  {
    id: 1, session_id: 1, project: 'cmem', type: 'decision',
    title: 'Use IMemoryClient interface for backend abstraction',
    subtitle: 'Architecture decision',
    narrative: 'Decided to introduce an IMemoryClient interface so commands never import WorkerClient directly. This enables future backends (SQLite, Mem0 MCP, AgentFS) to slot in via a factory without changing any command code.',
    facts: ['IMemoryClient has 20+ methods', 'WorkerClient implements it', 'Factory pattern in client-factory.ts'],
    concepts: ['architecture', 'abstraction', 'factory-pattern'],
    files_read: ['src/client.ts'], files_modified: ['src/memory-client.ts', 'src/client-factory.ts'],
    prompt_number: 1, discovery_tokens: 85,
    created_at_epoch: Date.now() - 3600000,
  },
  {
    id: 2, session_id: 1, project: 'cmem', type: 'feature',
    title: 'Add --dry-run flag to write commands',
    subtitle: 'Security hardening',
    narrative: 'Added --dry-run support to remember, settings set, and import-data commands. When set, the CLI validates input and shows a preview without making any API calls.',
    facts: ['remember --dry-run shows preview JSON', 'settings set --dry-run validates key against allowlist', 'import-data --dry-run counts records without importing'],
    concepts: ['security', 'dry-run', 'safety'],
    files_read: [], files_modified: ['src/commands/remember.ts', 'src/commands/settings.ts', 'src/commands/import-data.ts'],
    prompt_number: 2, discovery_tokens: 72,
    created_at_epoch: Date.now() - 1800000,
  },
  {
    id: 3, session_id: 1, project: 'cmem', type: 'bugfix',
    title: 'Fix stateful regex in privacy.ts causing alternating results',
    subtitle: 'Bug fix',
    narrative: 'The hasPrivateTags function used a module-level /g regex whose lastIndex persisted between calls, causing alternating true/false results. Fixed by constructing a fresh regex per call without the g flag.',
    facts: ['Module-level /g regex has stateful lastIndex', 'stripPrivateTags resets it via .replace', 'hasPrivateTags now uses fresh regex per call'],
    concepts: ['regex', 'privacy', 'bug'],
    files_read: [], files_modified: ['src/utils/privacy.ts'],
    prompt_number: 3, discovery_tokens: 45,
    created_at_epoch: Date.now() - 900000,
  },
  {
    id: 4, session_id: 2, project: 'cmem', type: 'discovery',
    title: 'Progressive disclosure saves 10x tokens for agent consumers',
    subtitle: 'Performance insight',
    narrative: 'Benchmarked the 3-layer search workflow. Layer 1 (search) returns ~50 tokens per result. Layer 2 (timeline) returns ~200 tokens total. Layer 3 (get) returns ~500-1000 tokens per observation. An agent that fetches 10 results via search, then gets details for 2, consumes ~1500 tokens vs ~7000 fetching everything.',
    facts: ['search: ~50 tokens/result', 'timeline: ~200 tokens total', 'get: ~500-1000 tokens/observation', '10x savings measured'],
    concepts: ['performance', 'tokens', 'progressive-disclosure'],
    files_read: [], files_modified: [],
    prompt_number: 1, discovery_tokens: 120,
    created_at_epoch: Date.now() - 600000,
  },
  {
    id: 5, session_id: 2, project: 'lesearch', type: 'change',
    title: 'Rebrand from Claude Memory to Context Memory for agent-agnostic positioning',
    subtitle: 'Branding change',
    narrative: 'Replaced ~50 claude-mem references across source and docs. Added CMEM_* env var aliases with CLAUDE_MEM_* backwards compat. Config now checks ~/.cmem/ first, falls back to ~/.claude-mem/.',
    facts: ['cmem = Context Memory', 'CMEM_* env vars preferred', '~/.cmem/ config path preferred', 'Backwards compat preserved'],
    concepts: ['branding', 'config', 'backwards-compatibility'],
    files_read: [], files_modified: ['src/config.ts', 'src/utils/validate.ts', 'package.json', 'README.md'],
    prompt_number: 2, discovery_tokens: 95,
    created_at_epoch: Date.now() - 300000,
  },
];

const MOCK_SUMMARIES = [
  {
    id: 1, content_session_id: 'session-1', memory_session_id: 'mem-1',
    project: 'cmem', summary_text: 'Built cmem CLI v0.1.0 with 20 commands, IMemoryClient interface, and 156 tests.',
    key_decisions: 'Commander.js for CLI, Bun for build, factory pattern for backend abstraction',
    files_modified: 'src/index.ts, src/memory-client.ts, src/client-factory.ts',
    created_at_epoch: Date.now() - 3600000,
  },
  {
    id: 2, content_session_id: 'session-2', memory_session_id: 'mem-2',
    project: 'cmem', summary_text: 'Hardened security with --dry-run, path masking, and port validation. Rebranded to Context Memory.',
    key_decisions: 'Agent-agnostic branding, dual config paths for backwards compat',
    files_modified: 'src/errors.ts, src/config.ts, src/commands/remember.ts',
    created_at_epoch: Date.now() - 600000,
  },
];

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // Health
    if (path === '/health' || path === '/api/health') {
      return Response.json({ status: 'ok', timestamp: Date.now() }, { headers });
    }

    // Stats
    if (path === '/api/stats') {
      return Response.json({
        worker: { version: '0.1.0-mock', uptime: 3600, activeSessions: 0, sseClients: 0, port: PORT },
        database: { path: `${process.env.HOME}/.claude-mem/claude-mem.db`, size: 524288, observations: MOCK_OBSERVATIONS.length, sessions: 2, summaries: MOCK_SUMMARIES.length },
      }, { headers });
    }

    // Projects
    if (path === '/api/projects') {
      const projects = [...new Set(MOCK_OBSERVATIONS.map(o => o.project))];
      return Response.json({ projects }, { headers });
    }

    // Search
    if (path === '/api/search') {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const project = url.searchParams.get('project');

      let results = MOCK_OBSERVATIONS;
      if (query) results = results.filter(o => o.title.toLowerCase().includes(query) || o.narrative.toLowerCase().includes(query) || o.concepts.some(c => c.includes(query)));
      if (project) results = results.filter(o => o.project === project);
      results = results.slice(0, limit);

      return Response.json({
        results: results.map(o => ({ id: o.id, type: o.type, title: o.title, timestamp: o.created_at_epoch, project: o.project, discoveryTokens: o.discovery_tokens })),
        total: results.length, query,
      }, { headers });
    }

    // Timeline
    if (path === '/api/timeline' || path === '/api/timeline/by-query') {
      const anchor = url.searchParams.get('anchor');
      const query = url.searchParams.get('query');
      const before = parseInt(url.searchParams.get('depth_before') || '5', 10);
      const after = parseInt(url.searchParams.get('depth_after') || '5', 10);

      let anchorIdx = 0;
      if (anchor) anchorIdx = MOCK_OBSERVATIONS.findIndex(o => o.id === parseInt(anchor, 10));
      if (query) anchorIdx = MOCK_OBSERVATIONS.findIndex(o => o.title.toLowerCase().includes(query.toLowerCase()));
      if (anchorIdx < 0) anchorIdx = 0;

      const start = Math.max(0, anchorIdx - before);
      const end = Math.min(MOCK_OBSERVATIONS.length, anchorIdx + after + 1);
      const items = MOCK_OBSERVATIONS.slice(start, end).map(o => ({
        id: o.id, type: 'observation' as const, title: o.title,
        timestamp: o.created_at_epoch, project: o.project,
        isAnchor: o.id === MOCK_OBSERVATIONS[anchorIdx].id,
      }));

      return Response.json({ items, anchor: items.find(i => i.isAnchor) }, { headers });
    }

    // Observations batch
    if (path === '/api/observations/batch' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { ids?: number[] };
        const ids = body.ids || [];
        const results = MOCK_OBSERVATIONS.filter(o => ids.includes(o.id));
        return Response.json(results, { headers });
      })();
    }

    // Single observation
    if (path.startsWith('/api/observation/')) {
      const id = parseInt(path.split('/').pop() || '0', 10);
      const obs = MOCK_OBSERVATIONS.find(o => o.id === id);
      if (!obs) return Response.json({ error: `Observation #${id} not found` }, { status: 404, headers });
      return Response.json(obs, { headers });
    }

    // Paginated observations
    if (path === '/api/observations') {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const items = MOCK_OBSERVATIONS.slice(offset, offset + limit);
      return Response.json({ items, total: MOCK_OBSERVATIONS.length, offset, limit, hasMore: offset + limit < MOCK_OBSERVATIONS.length }, { headers });
    }

    // Summaries
    if (path === '/api/summaries') {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const items = MOCK_SUMMARIES.slice(offset, offset + limit);
      return Response.json({ items, total: MOCK_SUMMARIES.length, offset, limit, hasMore: false }, { headers });
    }

    // Decisions
    if (path === '/api/decisions') {
      const results = MOCK_OBSERVATIONS.filter(o => o.type === 'decision');
      return Response.json({ results: results.map(o => ({ id: o.id, type: o.type, title: o.title, timestamp: o.created_at_epoch, project: o.project })), total: results.length }, { headers });
    }

    // Changes
    if (path === '/api/changes') {
      const results = MOCK_OBSERVATIONS.filter(o => o.type === 'change');
      return Response.json({ results: results.map(o => ({ id: o.id, type: o.type, title: o.title, timestamp: o.created_at_epoch, project: o.project })), total: results.length }, { headers });
    }

    // How it works
    if (path === '/api/how-it-works') {
      const results = MOCK_OBSERVATIONS.filter(o => o.type === 'discovery');
      return Response.json({ results: results.map(o => ({ id: o.id, type: o.type, title: o.title, timestamp: o.created_at_epoch, project: o.project })), total: results.length }, { headers });
    }

    // Context inject
    if (path === '/api/context/inject') {
      const project = url.searchParams.get('project') || url.searchParams.get('projects') || 'cmem';
      const obs = MOCK_OBSERVATIONS.filter(o => o.project === project);
      const text = `# Context for ${project}\n\n${obs.map(o => `- [${o.type}] ${o.title}`).join('\n')}`;
      return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Memory save
    if (path === '/api/memory/save' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { text?: string; title?: string; project?: string };
        const id = MOCK_OBSERVATIONS.length + 1;
        return Response.json({ success: true, id, title: body.title || (body.text || '').substring(0, 60), project: body.project || 'default', message: `Memory saved as observation #${id}` }, { headers });
      })();
    }

    // Settings
    if (path === '/api/settings') {
      if (req.method === 'POST') {
        return Response.json({ success: true, message: 'Settings updated successfully' }, { headers });
      }
      return Response.json({
        CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
        CLAUDE_MEM_WORKER_PORT: String(PORT),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_PROVIDER: 'claude',
        CLAUDE_MEM_LOG_LEVEL: 'INFO',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      }, { headers });
    }

    // Logs
    if (path === '/api/logs') {
      return Response.json({ logs: '[INFO] Mock worker started\n[INFO] Ready on port ' + PORT, path: '/tmp/mock-worker.log', exists: true, totalLines: 2, returnedLines: 2 }, { headers });
    }
    if (path === '/api/logs/clear' && req.method === 'POST') {
      return Response.json({ success: true, message: 'Log file cleared' }, { headers });
    }

    // Processing status
    if (path === '/api/processing-status') {
      return Response.json({ isProcessing: false, queueDepth: 0 }, { headers });
    }

    // Pending queue
    if (path === '/api/pending-queue') {
      return Response.json({ queue: { messages: [], totalPending: 0, totalProcessing: 0, totalFailed: 0, stuckCount: 0 }, recentlyProcessed: [], sessionsWithPendingWork: [] }, { headers });
    }

    // Branch
    if (path === '/api/branch/status') {
      return Response.json({ branch: 'main', isDefault: true }, { headers });
    }

    // Search help
    if (path === '/api/search/help') {
      return Response.json({ title: 'cmem Search API', description: 'Mock search help' }, { headers });
    }

    // SSE stream
    if (path === '/stream') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'session_started', data: { sessionId: 1, project: 'cmem' } })}\n\n`);

          let count = 0;
          const interval = setInterval(() => {
            count++;
            const obs = MOCK_OBSERVATIONS[count % MOCK_OBSERVATIONS.length];
            controller.enqueue(`data: ${JSON.stringify({ type: 'observation_saved', data: { id: obs.id + count * 10, type: obs.type, title: obs.title, project: obs.project, timestamp: Date.now() } })}\n\n`);
          }, 5000);

          req.signal.addEventListener('abort', () => {
            clearInterval(interval);
            controller.close();
          });
        },
      });

      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      });
    }

    // Root — serve a simple status page for browsers
    if (path === '/' || path === '') {
      const html = `<!DOCTYPE html>
<html><head><title>cmem — Context Memory Worker</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #666; margin-bottom: 32px; }
  .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
  .label { color: #666; }
  .value { font-weight: 600; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .section { margin-top: 24px; }
  h2 { font-size: 16px; color: #333; margin-bottom: 12px; }
  .endpoints { font-size: 13px; color: #555; }
  .endpoints a { color: #0066cc; text-decoration: none; }
  .endpoints a:hover { text-decoration: underline; }
  .badge { display: inline-block; background: #22c55e; color: white; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
</style></head>
<body>
  <h1>cmem <span class="badge">mock</span></h1>
  <div class="subtitle">Context Memory Worker — serving on port ${PORT}</div>

  <div class="stat"><span class="label">Status</span><span class="value" style="color:#22c55e">Running</span></div>
  <div class="stat"><span class="label">Observations</span><span class="value">${MOCK_OBSERVATIONS.length}</span></div>
  <div class="stat"><span class="label">Sessions</span><span class="value">${MOCK_SUMMARIES.length}</span></div>
  <div class="stat"><span class="label">Projects</span><span class="value">${[...new Set(MOCK_OBSERVATIONS.map(o => o.project))].join(', ')}</span></div>

  <div class="section">
    <h2>Try from the terminal</h2>
    <div class="endpoints">
      <code>cmem stats</code> — worker statistics<br>
      <code>cmem search "architecture"</code> — search observations<br>
      <code>cmem get 1 2 3</code> — fetch full details<br>
      <code>cmem stream</code> — live observation feed<br>
    </div>
  </div>

  <div class="section">
    <h2>API endpoints</h2>
    <div class="endpoints">
      <a href="/health">/health</a> ·
      <a href="/api/stats">/api/stats</a> ·
      <a href="/api/projects">/api/projects</a> ·
      <a href="/api/search?query=architecture">/api/search?query=architecture</a> ·
      <a href="/api/observations">/api/observations</a> ·
      <a href="/api/decisions">/api/decisions</a> ·
      <a href="/api/settings">/api/settings</a> ·
      <a href="/stream">/stream</a> (SSE)
    </div>
  </div>

  <div class="section" style="margin-top: 32px; font-size: 12px; color: #999;">
    cmem-cli v0.1.0 — Context Memory CLI<br>
    <a href="https://github.com/aryateja2106/cmem" style="color: #999;">github.com/aryateja2106/cmem</a>
  </div>
</body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return Response.json({ error: 'Not found', path }, { status: 404, headers });
  },
});

console.log(`Mock memory worker running on http://127.0.0.1:${PORT}`);
console.log(`Test with: cmem stats`);
console.log(`Press Ctrl+C to stop`);
