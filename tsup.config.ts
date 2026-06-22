import { defineConfig } from 'tsup'

// Two independent builds: the Node CLI/library, and the browser dashboard
// client. tsup runs them concurrently, so neither uses `clean` (it would race
// with the other's writes into the shared dist/) — the prebuild script cleans
// dist once. The client emits the bundled SPA + its static assets into
// dist/client, which the server serves (see src/server/http.ts).
export default defineConfig([
  {
    // server + CLI (Node)
    entry: ['src/cli.ts', 'src/index.ts'],
    format: ['esm'],
    target: 'node20',
    clean: false,
    dts: true,
    sourcemap: true,
    // better-sqlite3 (native) and commander stay external — tsup externalizes
    // package.json dependencies by default, which is what we want here.
  },
  {
    // dashboard client (browser) — bundled separately and served as a static
    // asset, so client code lives in real modules instead of a template literal.
    entry: { app: 'src/server/client/main.ts' },
    outDir: 'dist/client',
    format: ['iife'],
    target: 'es2018',
    platform: 'browser',
    tsconfig: 'src/server/client/tsconfig.json',
    publicDir: 'src/server/client/public', // copies index.html + styles.css → dist/client
    outExtension: () => ({ js: '.js' }), // app.js (not app.global.js)
    clean: false, // keep the server build emitted above
    dts: false,
    sourcemap: true,
  },
])
