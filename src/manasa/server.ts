// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { ManasaCognitiveAgent } from './cognition/cognitive-agent.js';
import { COGNITIVE_INTENTS, type CognitiveIntent, type LanguagePreference } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const RUNTIME_DIR = join(REPO_ROOT, '.scratch', 'manasa-runtime');
mkdirSync(RUNTIME_DIR, { recursive: true });

const PORT = Number(process.env.MANASA_PORT || process.env.PORT || 4321);
const HOST = '0.0.0.0';

async function compileFrontendBundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(__dirname, 'ui', 'index.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    minify: false,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  return result.outputFiles[0].text;
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MANASA-1 (මනස-1) • Human-Like Cognitive AI Brain on claude-mem</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&family=Noto+Sans+Sinhala:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="icon" type="image/png" href="/assets/manasa-avatar.png" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export async function startManasaServer(port = PORT) {
  console.log('[MANASA-1] Initializing Neural Cortex, Limbic Engine, & claude-mem SQLite Hippocampus...');
  const agent = new ManasaCognitiveAgent({
    dbPath: join(RUNTIME_DIR, 'manasa-claude-mem.db'),
    checkpointPath: join(RUNTIME_DIR, 'manasa-weights.json'),
    limbicStatePath: join(RUNTIME_DIR, 'manasa-limbic.json'),
  });

  console.log('[MANASA-1] Bundling React 19 Observatory UI...');
  const appJs = await compileFrontendBundle();
  const stylesPath = join(__dirname, 'ui', 'styles.css');
  const avatarPath = join(__dirname, 'ui', 'assets', 'manasa-avatar.png');
  const heroBrainPath = join(__dirname, 'ui', 'assets', 'manasa-hero-brain.jpg');

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

  const server = Bun.serve({
    hostname: HOST,
    port,
    async fetch(req: Request): Promise<Response> {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(req.url);
      const pathname = url.pathname;

      try {
        // Static UI routes
        if (pathname === '/' || pathname === '/index.html') {
          return new Response(INDEX_HTML, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/html; charset=utf-8',
            },
          });
        }

        if (pathname === '/app.js') {
          return new Response(appJs, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/javascript; charset=utf-8',
            },
          });
        }

        if (pathname === '/styles.css') {
          const css = readFileSync(stylesPath, 'utf-8');
          return new Response(css, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/css; charset=utf-8',
            },
          });
        }

        if (pathname === '/assets/manasa-avatar.png' && existsSync(avatarPath)) {
          return new Response(Bun.file(avatarPath), {
            headers: { ...corsHeaders, 'Content-Type': 'image/png' },
          });
        }

        if (pathname === '/assets/manasa-hero-brain.jpg' && existsSync(heroBrainPath)) {
          return new Response(Bun.file(heroBrainPath), {
            headers: { ...corsHeaders, 'Content-Type': 'image/jpeg' },
          });
        }

        // Cognitive & claude-mem REST API
        if (pathname === '/api/health' && req.method === 'GET') {
          return jsonResponse({
            ok: true,
            model: 'MANASA-1',
            parameters: agent.cortex.getTotalParameters(),
          });
        }

        if (pathname === '/api/state' && req.method === 'GET') {
          return jsonResponse({
            limbic: agent.limbic.getState(),
            stats: agent.cortex.getStats(),
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
            history: agent.getConversationHistory(),
            externalSettings: agent.getExternalSettings(),
          });
        }

        if (pathname === '/api/chat' && req.method === 'POST') {
          const body = (await req.json()) as {
            message?: string;
            languagePref?: LanguagePreference;
          };
          const message = String(body.message ?? '').trim();
          if (!message) {
            return jsonResponse({ error: 'Message is required' }, 400);
          }
          const result = await agent.chat(message, body.languagePref ?? 'auto');
          return jsonResponse({
            ...result,
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
          });
        }

        if (pathname === '/api/probe' && req.method === 'POST') {
          const body = (await req.json()) as { text?: string };
          const text = String(body.text ?? '');
          return jsonResponse(agent.probeUtterance(text));
        }

        if (pathname === '/api/memories' && req.method === 'GET') {
          const kind = url.searchParams.get('kind') ?? 'all';
          const q = url.searchParams.get('q') ?? '';
          return jsonResponse({
            memories: agent.hippocampus.listMemories(kind, q),
          });
        }

        if (pathname === '/api/memories' && req.method === 'POST') {
          const body = (await req.json()) as { text?: string };
          const text = String(body.text ?? '').trim();
          if (!text) return jsonResponse({ error: 'Memory text required' }, 400);

          const extracted = agent.hippocampus.extractPersonalFacts(text);
          if (extracted.length > 0) {
            for (const f of extracted) agent.hippocampus.storeFact(f, 'trust');
          } else {
            agent.hippocampus.storeFact(
              {
                slot: 'custom.fact',
                subject: 'Semantic Memory',
                value: text,
                concepts: ['Semantic Memory'],
                rawText: text,
              },
              'trust',
            );
          }

          return jsonResponse({
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
          });
        }

        const reinforceMatch = pathname.match(/^\/api\/memories\/([^/]+)\/reinforce$/);
        if (reinforceMatch && req.method === 'POST') {
          const id = decodeURIComponent(reinforceMatch[1]);
          const updated = agent.hippocampus.reinforceMemoryItem(id);
          return jsonResponse({
            updated,
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
          });
        }

        const deleteMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
        if (deleteMatch && req.method === 'DELETE') {
          const id = decodeURIComponent(deleteMatch[1]);
          const deleted = agent.hippocampus.deleteMemoryItem(id);
          return jsonResponse({
            deleted,
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
          });
        }

        if (pathname === '/api/graph' && req.method === 'GET') {
          return jsonResponse(agent.hippocampus.buildKnowledgeGraph());
        }

        if (pathname === '/api/consolidate' && req.method === 'POST') {
          const consolidated = agent.runRemConsolidation();
          return jsonResponse({
            ...consolidated,
            memories: agent.hippocampus.listMemories('all'),
          });
        }

        if (pathname === '/api/train' && req.method === 'POST') {
          const body = (await req.json()) as { epochs?: number; learningRate?: number };
          const epochs = Math.max(1, Math.min(80, Number(body.epochs ?? 15)));
          const lr = Math.max(0.0005, Math.min(0.05, Number(body.learningRate ?? 0.008)));
          const runMetrics = agent.cortex.trainEpochs(epochs, lr, true);
          return jsonResponse({
            runMetrics,
            stats: agent.cortex.getStats(),
          });
        }

        if (pathname === '/api/teach' && req.method === 'POST') {
          const body = (await req.json()) as {
            phrase?: string;
            intent?: CognitiveIntent;
            customReply?: string;
          };
          const phrase = String(body.phrase ?? '').trim();
          const intent: CognitiveIntent = COGNITIVE_INTENTS.includes(body.intent as CognitiveIntent)
            ? (body.intent as CognitiveIntent)
            : 'casual_chat';
          if (!phrase) return jsonResponse({ error: 'Phrase is required' }, 400);

          const res = agent.teachExplicit({
            phrase,
            intent,
            customReply: body.customReply,
          });
          return jsonResponse({
            ...res,
            memories: agent.hippocampus.listMemories('all'),
            graph: agent.hippocampus.buildKnowledgeGraph(),
          });
        }

        if (pathname === '/api/settings' && req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          const externalSettings = agent.updateExternalSettings(body);
          return jsonResponse({ externalSettings });
        }

        return new Response(INDEX_HTML, {
          headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, 500);
      }
    },
  });

  console.log(`[MANASA-1] Living Cognitive Brain & Observatory listening on http://${HOST}:${server.port}`);
  return { server, agent };
}

if (import.meta.main) {
  startManasaServer();
}
