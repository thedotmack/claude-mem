import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const LOCAL_WORKER = 'http://127.0.0.1:37777'

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
        configure: (proxy) => proxy.on('proxyReq', (proxyRequest) => proxyRequest.setHeader('origin', LOCAL_WORKER)),
      },
    },
  },
})
