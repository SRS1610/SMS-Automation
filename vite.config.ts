/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Phone-number metadata is large and rarely changes: keep it in its own cacheable chunk.
        manualChunks: { phone: ['libphonenumber-js/max'], vendor: ['react', 'react-dom', 'papaparse'] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/webhooks': `http://localhost:${apiPort}`,
    },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
