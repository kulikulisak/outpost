import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import pkg from './package.json';
// The phone app reuses the desktop's transcript reducer and model/effort lists.
export default defineConfig({
  base: '/',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@desktop': path.resolve(__dirname, '../desktop/src/renderer') } },
  server: { proxy: { '/api': 'http://127.0.0.1:7788', '/vnc': { target: 'ws://127.0.0.1:7788', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
});
