'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const outputDir = path.resolve(process.argv[2]);
const nonce = process.argv[3];
const port = Number(process.argv[4] || 37877);
const evidencePath = path.join(outputDir, 'fixture-requests.jsonl');
const readyPath = path.join(outputDir, 'fixture-ready.json');
const errorPath = path.join(outputDir, 'fixture-error.json');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(evidencePath, '');

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const record = { at: new Date().toISOString(), pid: process.pid, method: req.method, url: req.url, body };
    fs.appendFileSync(evidencePath, JSON.stringify(record) + '\n');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/api/health') return json(res, 200, { status: 'ok', initialized: true, version: 'profile-fixture' });
    if (url.pathname === '/api/readiness') return json(res, 200, { status: 'ready' });
    if (url.pathname === '/api/ready') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end('event: phase\ndata: {"phase":"ready"}\n\n');
      return;
    }
    if (url.pathname === '/api/sessions/init') return json(res, 200, { sessionDbId: 17, promptNumber: 3, skipped: false, contextInjected: false });
    if (url.pathname === '/api/context/semantic') return json(res, 200, { context: 'PROFILE_SEMANTIC_CONTEXT', count: 1 });
    // This production route is text. Returning an object creates a false-positive
    // valid JSON sample while the handler correctly rejects the response.
    if (url.pathname === '/api/context/inject') return text(res, 200, 'PROFILE_TIMELINE_CONTEXT');
    if (url.pathname === '/api/projects') return json(res, 200, { projects: [] });
    if (url.pathname === '/api/observations/by-file') return json(res, 200, {
      count: 1,
      observations: [{
        id: 91,
        memory_session_id: `fixture-history-${nonce}`,
        title: 'PROFILE_FILE_HISTORY',
        type: 'discovery',
        created_at_epoch: Date.now() + 60_000,
        files_read: '[]',
        files_modified: '[]'
      }]
    });
    if (url.pathname === '/api/spool/nudge') return json(res, 202, { status: 'draining' });
    return json(res, 404, { error: 'profile fixture has no route', path: url.pathname });
  });
});

server.on('error', error => {
  const temp = `${errorPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ nonce, pid: process.pid, code: error.code, message: error.message }));
  fs.renameSync(temp, errorPath);
  process.exitCode = 2;
});

server.listen(port, '127.0.0.1', () => {
  const temp = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ nonce, pid: process.pid, port, address: '127.0.0.1' }));
  fs.renameSync(temp, readyPath);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
