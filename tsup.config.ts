import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/server.ts',
    'src/mcp-server.ts',
    'src/conduit-mcp-server.ts',
    'src/daemon/daemon.ts',
    'electron/main.ts',
    'electron/preload.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  // Never wipe dist here: the client build lives in dist/client and a
  // server-only rebuild (or `tsup --watch`) must not delete it. The
  // top-level `npm run build` clears dist first via `npm run clean`.
  clean: false,
  sourcemap: true,
  external: ['electron', 'node-pty', 'electron-updater'],
});
