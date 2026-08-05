import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { Store } from './store'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tuneloop-migrate-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a store, then replace detector_runs with its pre-log shape (keyed on
 * `detector`, no `id`) — the state a store created before schema 18 is in.
 * Reopening it runs the rebuild migration.
 */
function seedPreLogStore(rows: Array<[string, number, string | null, string | null, number | null]>): string {
  const path = join(dir, `m${n++}.db`)
  const db = openDb(path)
  db.exec(`
    DROP TABLE detector_runs;
    CREATE TABLE detector_runs (
      detector    TEXT PRIMARY KEY,
      version     INTEGER NOT NULL,
      status      TEXT,
      model       TEXT,
      in_tokens   INTEGER,
      out_tokens  INTEGER,
      cost_usd    REAL,
      ran_at      TEXT NOT NULL
    );
  `)
  const stmt = db.prepare(
    'INSERT INTO detector_runs (detector, version, status, model, in_tokens, out_tokens, cost_usd, ran_at) VALUES (?,?,?,?,NULL,NULL,?,?)',
  )
  for (const [detector, version, status, model, cost] of rows) {
    stmt.run(detector, version, status, model, cost, '2026-07-01T00:00:00Z')
  }
  db.close()
  return path
}

describe('detector_runs → append-only log migration', () => {
  it('carries each detector\'s surviving row over as its first log entry', () => {
    const path = seedPreLogStore([
      ['themes', 2, 'ok', 'claude-haiku-4-5', 0.42],
      ['cache-miss', 1, 'ok', null, null], // S-tier: no model, no spend
    ])
    const db = openDb(path)
    const rows = db.prepare('SELECT id, detector, version, status, model, cost_usd FROM detector_runs ORDER BY detector').all()
    expect(rows).toEqual([
      { id: expect.any(Number), detector: 'cache-miss', version: 1, status: 'ok', model: null, cost_usd: null },
      { id: expect.any(Number), detector: 'themes', version: 2, status: 'ok', model: 'claude-haiku-4-5', cost_usd: 0.42 },
    ])
    db.close()
  })

  it('coalesces a NULL status — the old column was nullable, the new one is NOT NULL', () => {
    // A NULL would fail the insert and leave the store unopenable, so this is the
    // difference between a migration and a brick.
    const path = seedPreLogStore([['legacy', 1, null, null, null]])
    const db = openDb(path)
    expect(db.prepare('SELECT status FROM detector_runs WHERE detector = ?').get('legacy')).toMatchObject({ status: 'ok' })
    db.close()
  })

  it('appends after migrating instead of overwriting the carried-over row', () => {
    const path = seedPreLogStore([['themes', 2, 'ok', 'claude-haiku-4-5', 0.42]])
    const db = openDb(path)
    const store = new Store(db)
    store.persistDetectorError('themes', 2)
    const rows = db.prepare('SELECT status, model, cost_usd FROM detector_runs WHERE detector = ? ORDER BY id').all('themes')
    expect(rows).toEqual([
      { status: 'ok', model: 'claude-haiku-4-5', cost_usd: 0.42 },
      { status: 'error', model: null, cost_usd: null },
    ])
    // Pre-migration spend and model both survive the error run.
    expect(store.detectorLastSuccessfulModel('themes')).toBe('claude-haiku-4-5')
    expect(store.summary().analysisCostUsd).toBeCloseTo(0.42, 5)
    db.close()
  })

  it('is idempotent — reopening an already-migrated store changes nothing', () => {
    const path = seedPreLogStore([['themes', 2, 'ok', 'claude-haiku-4-5', 0.42]])
    openDb(path).close()
    const db = openDb(path) // migrate() runs on every openDb, gated on the `id` column
    expect(db.prepare('SELECT COUNT(*) AS c FROM detector_runs').get()).toMatchObject({ c: 1 })
    db.close()
  })
})

/**
 * Roll a store back to its pre-v22 tool-call shape — `tool_calls` without
 * `result_empty`, no `tool_call_commands` — with one call already in it. This is
 * what an npm user's existing store looks like; reopening it must upgrade in
 * place, not lose the row (back-compat is required, not optional).
 */
function seedPreToolHealthStore(): string {
  const path = join(dir, `t${n++}.db`)
  const db = openDb(path)
  db.exec(`
    DROP TABLE tool_call_commands;
    DROP TABLE tool_calls;
    CREATE TABLE tool_calls (
      session_id   TEXT,
      idx          INTEGER,
      name         TEXT,
      action       TEXT,
      ok           INTEGER,
      is_error     INTEGER,
      error_category TEXT,
      error_message TEXT,
      target_path  TEXT,
      command      TEXT,
      is_sidechain INTEGER,
      ts           TEXT,
      duration_ms  INTEGER,
      PRIMARY KEY (session_id, idx),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `)
  db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run('s1', 's1', 'claude-code', 'anthropic')
  db.prepare("INSERT INTO tool_calls (session_id, idx, name, action, ok, command) VALUES ('s1', 0, 'Bash', 'shell', 1, 'git status')").run()
  db.close()
  return path
}

describe('tool-call health migration (schema 22)', () => {
  it('adds result_empty to an existing tool_calls without touching its rows', () => {
    const db = openDb(seedPreToolHealthStore())
    expect(db.prepare('SELECT command, result_empty AS e FROM tool_calls').get()).toEqual({ command: 'git status', e: null })
    db.close()
  })

  it('creates tool_call_commands empty — it backfills on re-ingest, not in the migration', () => {
    // Backfilling here would mean re-parsing every stored command against a parser
    // that will keep changing; the NORMALIZE_VERSION bump re-ingests instead.
    const db = openDb(seedPreToolHealthStore())
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_call_commands').get()).toMatchObject({ c: 0 })
    db.close()
  })

  it('is idempotent — a second open neither re-adds the column nor drops rows', () => {
    const path = seedPreToolHealthStore()
    openDb(path).close()
    const db = openDb(path)
    expect(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get()).toMatchObject({ c: 1 })
    db.close()
  })
})

/**
 * The shell-binary scope — "is this tool call one that ran `grep`?" — is evaluated
 * once per tool call on every binary's detail page. Indexed on (binary) alone,
 * SQLite seeks to the binary and then compares session_id/idx row by row, which on a
 * real store meant millions of comparisons and a 21-second page load. Asserting the
 * PLAN rather than a duration keeps this honest without being timing-flaky.
 */
describe('tool_call_commands lookup index', () => {
  it('seeks on all three columns the shell scope constrains', () => {
    const db = openDb(join(dir, `idx${n++}.db`))
    const plan = (db.prepare(`EXPLAIN QUERY PLAN
      SELECT 1 FROM tool_calls t WHERE EXISTS (
        SELECT 1 FROM tool_call_commands c
        WHERE c.session_id = t.session_id AND c.idx = t.idx AND c.binary = 'grep')`)
      .all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ')

    expect(plan).toMatch(/SEARCH c/)
    expect(plan).toMatch(/binary=\? AND session_id=\? AND idx=\?/)
    expect(plan).not.toMatch(/SCAN c/)
    db.close()
  })

  it('drops the redundant single-column index it supersedes', () => {
    const path = join(dir, `idx${n++}.db`)
    const old = openDb(path)
    old.exec('CREATE INDEX IF NOT EXISTS ix_tool_call_commands_binary ON tool_call_commands(binary)')
    old.close()

    const db = openDb(path)
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_call_commands'`)
      .all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('ix_tool_call_commands_call')
    expect(names).not.toContain('ix_tool_call_commands_binary')
    db.close()
  })
})
