import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { withThemePrePaintScript } from './src/lib/theme-pre-paint.ts'

const LOCAL_WORKER = 'http://127.0.0.1:37777'

/** Decision G8: the theme script runs inline in <head>, before the first paint, written from the theme's one definition. */
const themePrePaint: Plugin = { name: 'claude-mem-theme-pre-paint', transformIndexHtml: { order: 'pre', handler: withThemePrePaintScript } }

export default defineConfig({
  // The worker serves index.html at / but the assets under /work-view/, so relative paths would break.
  base: '/work-view/',
  build: { outDir: '../../../plugin/ui/work-view', emptyOutDir: true },
  plugins: [react(), tailwindcss(), themePrePaint],
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
        configure: (proxy) => proxy.on('proxyReq', (proxyRequest) => proxyRequest.setHeader('origin', LOCAL_WORKER)),
      },
    },
  },
})
