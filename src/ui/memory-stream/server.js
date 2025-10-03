#!/usr/bin/env node

import { watch, existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const DB_PATH = join(homedir(), '.claude-mem/claude-mem.db');
const SESSIONS_DIR = join(homedir(), '.claude-mem/sessions');
const PORT = 3001;

let clients = [];
let lastMaxId = 0;
let lastOverviewId = 0;

function safeJsonParse(jsonString) {
  if (!jsonString) return [];
  try {
    return JSON.parse(jsonString);
  } catch {
    return [];
  }
}

function getMemories(minId = 0) {
  const db = new Database(DB_PATH, { readonly: true });
  const memories = db.prepare(`
    SELECT id, session_id, created_at, project, origin, title, subtitle, facts, concepts, files_touched
    FROM memories
    WHERE id > ? AND title IS NOT NULL
    ORDER BY id DESC
  `).all(minId);
  db.close();

  return memories.map(m => ({
    ...m,
    facts: safeJsonParse(m.facts),
    concepts: safeJsonParse(m.concepts),
    files_touched: safeJsonParse(m.files_touched)
  }));
}

function getOverviews(minId = 0) {
  const db = new Database(DB_PATH, { readonly: true });
  const overviews = db.prepare(`
    SELECT id, session_id, content, created_at, project, origin
    FROM overviews
    WHERE id > ?
    ORDER BY id DESC
  `).all(minId);
  db.close();

  // Enrich overviews with session titles/subtitles from session JSON files
  return overviews.map(overview => {
    const sessionFile = join(SESSIONS_DIR, `${overview.project}_streaming.json`);
    let promptTitle = null;
    let promptSubtitle = null;

    try {
      if (existsSync(sessionFile)) {
        const sessionData = JSON.parse(readFileSync(sessionFile, 'utf8'));
        // Only attach title/subtitle if it's from the same Claude session
        if (sessionData.claudeSessionId === overview.session_id) {
          promptTitle = sessionData.promptTitle || null;
          promptSubtitle = sessionData.promptSubtitle || null;
        }
      }
    } catch (e) {
      // Ignore errors reading session file
    }

    return {
      ...overview,
      promptTitle,
      promptSubtitle
    };
  });
}

function getSessions() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get unique sessions from overviews
  const sessions = db.prepare(`
    SELECT DISTINCT
      o.session_id,
      o.project,
      o.created_at,
      o.content as overview_content
    FROM overviews o
    ORDER BY o.created_at DESC
    LIMIT 50
  `).all();

  db.close();

  return sessions;
}

function getSessionData(sessionId) {
  const db = new Database(DB_PATH, { readonly: true });

  const overview = db.prepare(`
    SELECT id, session_id, content, created_at, project, origin
    FROM overviews
    WHERE session_id = ?
    LIMIT 1
  `).get(sessionId);

  const memories = db.prepare(`
    SELECT id, session_id, created_at, project, origin, title, subtitle, facts, concepts, files_touched
    FROM memories
    WHERE session_id = ? AND title IS NOT NULL
    ORDER BY id ASC
  `).all(sessionId);

  db.close();

  return {
    overview,
    memories: memories.map(m => ({
      ...m,
      facts: safeJsonParse(m.facts),
      concepts: safeJsonParse(m.concepts),
      files_touched: safeJsonParse(m.files_touched)
    }))
  };
}

function broadcast(type, data) {
  const message = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  clients.forEach(client => client.write(message));
}

function broadcastSessionState(eventType, project) {
  const message = `data: ${JSON.stringify({ type: eventType, project })}\n\n`;
  clients.forEach(client => client.write(message));
  console.log(`📡 Broadcasting ${eventType} for project: ${project}`);
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    clients.push(res);
    console.log(`🔌 Client connected (${clients.length} total)`);

    const allMemories = getMemories(-1);
    lastMaxId = allMemories.length > 0 ? Math.max(...allMemories.map(m => m.id)) : 0;

    const allOverviews = getOverviews(-1);
    lastOverviewId = allOverviews.length > 0 ? Math.max(...allOverviews.map(o => o.id)) : 0;

    console.log(`📦 Sending ${allMemories.length} memories and ${allOverviews.length} overviews to new client`);
    broadcast('initial_load', { memories: allMemories, overviews: allOverviews });

    req.on('close', () => {
      clients = clients.filter(client => client !== res);
      console.log(`🔌 Client disconnected (${clients.length} remaining)`);
    });
  } else if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sessions = getSessions();
    res.end(JSON.stringify(sessions));
  } else if (req.url.startsWith('/api/session/')) {
    const sessionId = req.url.replace('/api/session/', '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sessionData = getSessionData(sessionId);
    res.end(JSON.stringify(sessionData));
  } else {
    res.writeHead(404);
    res.end();
  }
});

watch(DB_PATH, (eventType) => {
  const newMemories = getMemories(lastMaxId);
  if (newMemories.length > 0) {
    lastMaxId = Math.max(...newMemories.map(m => m.id));
    console.log(`✨ Broadcasting ${newMemories.length} new memories`);
    broadcast('new_memories', { memories: newMemories });
  }

  const newOverviews = getOverviews(lastOverviewId);
  if (newOverviews.length > 0) {
    lastOverviewId = Math.max(...newOverviews.map(o => o.id));
    console.log(`✨ Broadcasting ${newOverviews.length} new overviews`);
    broadcast('new_overviews', { overviews: newOverviews });
  }
});

watch(SESSIONS_DIR, (eventType, filename) => {
  if (!filename || !filename.endsWith('_streaming.json')) return;

  const project = filename.replace('_streaming.json', '');
  const sessionPath = join(SESSIONS_DIR, filename);

  if (eventType === 'rename') {
    // Check if file exists to determine if it was created or deleted
    if (existsSync(sessionPath)) {
      broadcastSessionState('session_start', project);
    } else {
      broadcastSessionState('session_end', project);
    }
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Memory Stream Server running on http://localhost:${PORT}`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/stream`);
});

process.on('SIGINT', () => {
  clients.forEach(client => client.end());
  server.close();
  process.exit(0);
});
