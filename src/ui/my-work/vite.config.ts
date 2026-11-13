import { readFileSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A worker on another port (a second install, a test worker) is reached by naming its port.
const LOCAL_WORKER = `http://127.0.0.1:${process.env.CLAUDE_MEM_WORKER_PORT ?? 37777}`

export default defineConfig({
  // The worker serves index.html at / but the assets under /work-view/, so relative paths would break.
  base: '/work-view/',
  build: { outDir: '../../../plugin/ui/work-view', emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  // Shared UI localization lives outside this Vite package. Resolve React from
  // this app for both it and the app, so hooks never cross React instances.
  resolve: { alias: { '@': path.resolve(__dirname, './src') }, dedupe: ['react', 'react-dom'] },
  server: {
    proxy: {
      // The worker's /api/work-view routes are loopback-only and reject forwarded headers, so no xfwd.
      // Writes also need a loopback Origin on the same port as the Host, so the proxy presents the worker's
      // own Host (changeOrigin) and Origin.
      '/api': {
        target: LOCAL_WORKER,
        changeOrigin: true,
        // Previewing a checkout against an installed worker, which maps requests with its own older code:
        // CLAUDE_MEM_MAP_IN_BROWSER answers the compact overview with 404, so the page takes the full snapshot and
        // maps it here. CLAUDE_MEM_SNAPSHOT_FILE serves that snapshot from a file and refuses every write, for
        // looking at real data with fields the installed worker does not send yet.
        bypass: (request, response) => {
          if (!response) return undefined
          const url = request.url ?? ''
          const snapshotFile = process.env.CLAUDE_MEM_SNAPSHOT_FILE
          const end = (status: number, body = '') => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(body); return false as const }
          if (snapshotFile && request.method !== 'GET') return end(405, JSON.stringify({ error: 'This preview is read-only.' }))
          if ((snapshotFile || process.env.CLAUDE_MEM_MAP_IN_BROWSER) && /^\/api\/work-view\/(overview|events)/.test(url)) return end(404)
          if (snapshotFile && /^\/api\/work-view(\?|$)/.test(url)) return end(200, readFileSync(snapshotFile, 'utf8'))
          return undefined
        },
        configure: (proxy) => proxy.on('proxyReq', (proxyRequest) => proxyRequest.setHeader('origin', LOCAL_WORKER)),
      },
    },
  },
})
