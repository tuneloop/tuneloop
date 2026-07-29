#!/usr/bin/env node
// Node-version gate. Lives outside dist/ because the bundle statically imports
// dependencies (better-sqlite3, transitively undici) that fail on unsupported
// Node versions with inscrutable module-load stack traces — the check must run
// before any of that is even parsed. Keep this file dependency-free and free of
// recent syntax so ancient Nodes can still execute it far enough to print the
// message. The floor comes from package.json `engines`, the single source of
// truth (which must in turn cover our deps' floors — undici's is the binding
// one; re-check when bumping it).
import { readFileSync } from 'node:fs'

const { engines } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const required = engines.node.replace(/^[^\d]*/, '') // '>=22.19.0' → '22.19.0'
const parse = (v) => v.split('.').map((n) => Number(n) || 0)
const [maj, min, pat] = parse(process.versions.node)
const [reqMaj, reqMin, reqPat] = parse(required)

const tooOld =
  maj < reqMaj ||
  (maj === reqMaj && (min < reqMin || (min === reqMin && pat < reqPat)))

if (tooOld) {
  console.error(
    `tuneloop requires Node.js >= ${required}; you are running ${process.version}.`,
  )
  console.error(
    'Upgrade Node and retry (with nvm: `nvm install 22 && nvm use 22`).',
  )
  process.exit(1)
}

import('../dist/cli.js')
