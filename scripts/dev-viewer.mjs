#!/usr/bin/env node
// Standalone viewer dev server.
//
// Serves THIS worktree's viewer (src/ui/viewer) on its own port with
// esbuild watch + live reload, and proxies all data routes (/api/*,
// /stream, /health, ...) to the already-running claude-mem worker so
// the installed plugin on :37777 is never touched.
//
//   node scripts/dev-viewer.mjs
//   VIEWER_DEV_PORT=48888 node scripts/dev-viewer.mjs

import * as esbuild from 'esbuild';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const PORT = Number(process.env.VIEWER_DEV_PORT || 47777);
const UPSTREAM_HOST = process.env.VIEWER_DEV_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.VIEWER_DEV_UPSTREAM_PORT || 37777);

const outDir = path.join(rootDir, 'node_modules', '.cache', 'dev-viewer');
const bundlePath = path.join(outDir, 'viewer-bundle.js');
const templatePath = path.join(rootDir, 'src', 'ui', 'viewer-template.html');

// Static fallback roots, tried in order (mirrors worker's express.static on plugin/ui)
const STATIC_ROOTS = [
  path.join(rootDir, 'src', 'ui'),
  path.join(rootDir, 'src', 'ui', 'viewer'),
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ---- live reload ----
const reloadClients = new Set();
function notifyReload() {
  for (const res of reloadClients) {
    res.write('data: reload\n\n');
  }
}

// ---- esbuild watch ----
fs.mkdirSync(outDir, { recursive: true });
const ctx = await esbuild.context({
  entryPoints: [path.join(rootDir, 'src/ui/viewer/index.tsx')],
  bundle: true,
  minify: false,
  sourcemap: 'inline',
  target: ['es2020'],
  format: 'iife',
  outfile: bundlePath,
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info',
  plugins: [{
    name: 'live-reload-notify',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) notifyReload();
      });
    },
  }],
});
await ctx.watch();

// Template edits also trigger a reload (served fresh on every request)
fs.watch(templatePath, () => notifyReload());

const LIVE_RELOAD_SNIPPET =
  '<script>new EventSource("/__livereload").onmessage=()=>location.reload();</script>';

function serveFile(res, filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function proxy(req, res) {
  const upstreamReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({
      error: `dev-viewer proxy: worker at ${UPSTREAM_HOST}:${UPSTREAM_PORT} unreachable`,
      detail: err.message,
    }));
  });
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(templatePath, 'utf-8')
      .replace('</body>', `${LIVE_RELOAD_SNIPPET}\n</body>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (pathname === '/viewer-bundle.js') {
    if (fs.existsSync(bundlePath)) {
      serveFile(res, bundlePath);
    } else {
      res.writeHead(503).end('bundle not built yet');
    }
    return;
  }

  if (pathname === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }

  // Local static assets (logos, icons, fonts) from this worktree's src/ui
  if (req.method === 'GET' && !pathname.startsWith('/api/') && pathname !== '/stream') {
    for (const root of STATIC_ROOTS) {
      const candidate = path.join(root, pathname);
      if (candidate.startsWith(root + path.sep) &&
          fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        serveFile(res, candidate);
        return;
      }
    }
  }

  // Everything else (API, SSE stream, health) → real worker
  proxy(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  dev viewer   → http://127.0.0.1:${PORT}`);
  console.log(`  data proxied ← http://${UPSTREAM_HOST}:${UPSTREAM_PORT} (untouched)`);
  console.log('');
  console.log('  watching src/ui/viewer/** and viewer-template.html (live reload on save)');
});
