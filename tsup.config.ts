import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // better-sqlite3 (native) and commander stay external — tsup externalizes
  // package.json dependencies by default, which is what we want here.
})
