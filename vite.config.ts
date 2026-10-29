import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit']
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3200',
      '/downloads': 'http://localhost:3200',
      '/ws': {
        target: 'ws://localhost:3200',
        ws: true,
      },
    },
  },
});
