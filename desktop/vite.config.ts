import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import pkg from './package.json';
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { 'novnc-keyboard': path.resolve(__dirname, 'node_modules/@novnc/novnc/core/input/keyboard.js'), 'novnc-logging': path.resolve(__dirname, 'node_modules/@novnc/novnc/core/util/logging.js') } },
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'esnext' },
});
