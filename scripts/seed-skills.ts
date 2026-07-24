/**
 * CLI wrapper around the synthetic skill-data generator (src/server/skill-seed.ts).
 * Seeds a throwaway sqlite store with the edge-case corpus for manual UI eyeballing.
 *
 * Usage:  npx tsx scripts/seed-skills.ts [dbPath]
 *   then: npx tsx src/cli.ts serve --db <dbPath> --port 7799   →   open #/skills
 *
 * `nowMs` is stamped once here (fine — this is the manual path, not the deterministic
 * test path, which passes a fixed nowMs straight into seedSkillStore).
 */

import { rmSync } from 'node:fs'
import { openDb } from '../src/store/db'
import { Store } from '../src/store/store'
import { seedSkillStore } from '../src/server/skill-seed'

const dbPath = process.argv[2] ?? '/tmp/skillhealth-synth.sqlite'
rmSync(dbPath, { force: true })
const db = openDb(dbPath)
const store = new Store(db)
const exp = seedSkillStore(store, { nowMs: Date.now() })
store.close()
console.log(`seeded ${dbPath}`)
console.log(JSON.stringify(exp, null, 2))
console.log(`\nserve:  npx tsx src/cli.ts serve --db ${dbPath} --port 7799`)
