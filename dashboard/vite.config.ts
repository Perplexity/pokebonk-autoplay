import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` serves the page with hot reload and passes /api on to the dashboard server (node dashboard/server/main.ts).
// Both listen on this machine only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? 8090}`, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2023' },
});
