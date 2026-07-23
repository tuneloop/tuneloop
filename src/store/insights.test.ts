import { describe, expect, it } from 'vitest'
import { openDb } from './db'
import { Store } from './store'
import { insightId } from '../core/detector'
import type { InsightInput } from '../core/detector'

function setup() {
  const db = openDb(':memory:')
  const store = new Store(db)
  for (const id of ['s1', 's2']) {
    db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, 'claude-code', 'anthropic')
  }
  return { db, store }
}

function mkInsight(over: Partial<InsightInput> = {}): InsightInput {
  const base: InsightInput = {
    signalKey: 'k1',
    repo: '*',
    severity: 'high',
    title: 'Repeated deploy corrections',
    description: 'User re-explained the deploy sequence in 6 sessions',
    evidence: [{ sessionId: 's1' }],
    count: 6,
    fix: { type: 'fix-prompt', label: 'Apply fix', content: '' },
    ...over,
  }
  if (!base.fix.content) base.fix = { ...base.fix, content: `tuneloop-fix: ${insightId('det', base.repo, base.signalKey)}\n...` }
  return base
}

const stateOf = (db: ReturnType<typeof openDb>, id: string) =>
  (db.prepare('SELECT state FROM insights WHERE id = ?').get(id) as { state: string }).state

describe('deterministic insight ids', () => {
  it('id derives from (detector, repo, signalKey) and is stable across rebuilds', () => {
    const a = setup()
    a.store.persistInsights('det', 1, [mkInsight()])
    const idA = (a.db.prepare('SELECT id FROM insights').get() as { id: string }).id
    expect(idA).toBe(insightId('det', '*', 'k1'))

    // A fresh store (rebuild) mints the identical id.
    const b = setup()
    b.store.persistInsights('det', 1, [mkInsight()])
    const idB = (b.db.prepare('SELECT id FROM insights').get() as { id: string }).id
    expect(idB).toBe(idA)
  })

  it('no concatenation-boundary collisions', () => {
    expect(insightId('a', 'bc', 'k')).not.toBe(insightId('ab', 'c', 'k'))
  })
})

describe('insight_state_log', () => {
  it('logs null→surfaced on first insert and resolved→surfaced on reopen', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    store.transitionInsight(id, 'resolved')
    store.persistInsights('det', 1, [mkInsight()]) // re-detection → reopen

    const log = db
      .prepare('SELECT from_state, to_state FROM insight_state_log WHERE insight_id = ? ORDER BY rowid')
      .all(id) as Array<{ from_state: string | null; to_state: string }>
    expect(log).toEqual([
      { from_state: null, to_state: 'surfaced' },
      { from_state: 'surfaced', to_state: 'resolved' },
      { from_state: 'resolved', to_state: 'surfaced' },
    ])
  })

  it('dismissInsight routes through the matrix and is logged', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    expect(store.dismissInsight(id)).toBe(true)
    expect(store.dismissInsight(id)).toBe(false) // already dismissed
    const last = db
      .prepare('SELECT from_state, to_state FROM insight_state_log WHERE insight_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id) as { from_state: string; to_state: string }
    expect(last).toEqual({ from_state: 'surfaced', to_state: 'dismissed' })
  })
})

describe('reconcileFixSightings', () => {
  const sight = (store: Store, sessionId: string, id: string, turnAt = '2026-07-01T10:00:00Z', seq = 4) =>
    store.recordFixMarkerSightings(sessionId, [{ insightId: id, seq, turnAt }])

  it('surfaced insight chains to adopted (fix_issued logged in between)', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    sight(store, 's1', id)
    expect(store.reconcileFixSightings()).toBe(1)
    expect(stateOf(db, id)).toBe('adopted')
    const states = db
      .prepare('SELECT to_state FROM insight_state_log WHERE insight_id = ? ORDER BY rowid')
      .all(id) as Array<{ to_state: string }>
    expect(states.map((s) => s.to_state)).toEqual(['surfaced', 'fix_issued', 'adopted'])
  })

  it('already-adopted / dismissed insights are matched without transitions', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight(), mkInsight({ signalKey: 'k2' })])
    const adoptedId = insightId('det', '*', 'k1')
    const dismissedId = insightId('det', '*', 'k2')
    sight(store, 's1', adoptedId)
    store.reconcileFixSightings()
    store.dismissInsight(dismissedId)
    sight(store, 's2', dismissedId)

    expect(store.reconcileFixSightings()).toBe(0) // no new adoptions
    expect(stateOf(db, dismissedId)).toBe('dismissed')
    const unmatched = db.prepare('SELECT COUNT(*) as n FROM fix_marker_sightings WHERE matched_at IS NULL').get() as { n: number }
    expect(unmatched.n).toBe(0) // both sightings matched regardless
  })

  it('unknown id stays unmatched, then matches once the insight appears (rebuild self-heal)', () => {
    const { db, store } = setup()
    const id = insightId('det', '*', 'k1')
    sight(store, 's1', id) // marker scanned before the detector re-creates the insight
    expect(store.reconcileFixSightings()).toBe(0)
    expect((db.prepare('SELECT matched_at FROM fix_marker_sightings').get() as { matched_at: string | null }).matched_at).toBeNull()

    store.persistInsights('det', 1, [mkInsight()])
    expect(store.reconcileFixSightings()).toBe(1)
    expect(stateOf(db, id)).toBe('adopted')
  })

  it('re-ingesting an adopted fix session keeps the insight↔session link', () => {
    const { store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    sight(store, 's1', id)
    store.reconcileFixSightings()
    expect(store.insights()[0]!.fixSessions.map((f) => f.sessionId)).toEqual(['s1'])

    // Resume of the fix session → wipe-and-replace re-inserts the sighting unmatched.
    sight(store, 's1', id)
    expect(store.reconcileFixSightings()).toBe(0) // no transition — already adopted
    const row = store.insights()[0]!
    expect(row.state).toBe('adopted')
    expect(row.fixSessions.map((f) => f.sessionId)).toEqual(['s1']) // link survived
  })

  it('rejects a fix-prompt that does not embed its own insight id', () => {
    const { store } = setup()
    expect(() => store.persistInsights('det', 1, [mkInsight({ fix: { type: 'fix-prompt', label: 'Apply', content: 'no marker here' } })])).toThrow(
      /does not embed its insight id/,
    )
  })

  it('one adoption when two sessions sight the same insight in one reconcile', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    store.recordFixMarkerSightings('s1', [{ insightId: id, seq: 4, turnAt: '2026-07-01T10:00:00Z' }])
    store.recordFixMarkerSightings('s2', [{ insightId: id, seq: 2, turnAt: '2026-07-01T11:00:00Z' }])

    expect(store.reconcileFixSightings()).toBe(1) // not 2 — matrix rejects the second pass
    expect(stateOf(db, id)).toBe('adopted')
    const unmatched = db.prepare('SELECT COUNT(*) as n FROM fix_marker_sightings WHERE matched_at IS NULL').get() as { n: number }
    expect(unmatched.n).toBe(0)
    expect(store.insights()[0]!.fixSessions.map((f) => f.sessionId)).toEqual(['s1', 's2'])
  })

  it('a re-scanned previous-cycle fix session does not re-adopt a reopened insight (variant A)', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')

    sight(store, 's1', id, '2020-01-01T00:00:00Z')
    store.reconcileFixSightings()
    store.transitionInsight(id, 'resolved')
    store.persistInsights('det', 1, [mkInsight()]) // recurrence → reopen

    // User resumes the OLD fix session → wipe-and-replace re-inserts its sighting unmatched.
    sight(store, 's1', id, '2020-01-01T00:00:00Z')
    expect(store.reconcileFixSightings()).toBe(0) // stale evidence must not transition
    expect(stateOf(db, id)).toBe('surfaced')
    const unmatched = db.prepare('SELECT COUNT(*) as n FROM fix_marker_sightings WHERE matched_at IS NULL').get() as { n: number }
    expect(unmatched.n).toBe(0) // …but it is matched, not retried forever
  })

  it('a genuine re-fix pasted before the reopen was recorded still adopts (variant B)', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')

    sight(store, 's1', id, '2020-01-01T00:00:00Z')
    store.reconcileFixSightings()
    store.transitionInsight(id, 'resolved')

    // Problem recurs; user re-pastes the fix (event time after the resolve) —
    // all of this lands in ONE analyze run: sighting recorded, then the
    // detector re-detection reopens, then reconcile.
    const rePaste = new Date(Date.now() + 60_000).toISOString()
    sight(store, 's2', id, rePaste, 2)
    store.persistInsights('det', 1, [mkInsight()]) // reopen (processing time AFTER the paste's event time)
    expect(store.reconcileFixSightings()).toBe(1)
    expect(stateOf(db, id)).toBe('adopted')
    const row = store.insights()[0]!
    expect(row.fixSessions.map((f) => f.sessionId)).toEqual(['s2'])
    expect(row.adoptedAt).toBe(rePaste)
  })

  it('a resolved insight keeps showing the fix that resolved it', () => {
    const { store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    sight(store, 's1', id, '2026-06-01T10:00:00Z')
    store.reconcileFixSightings()
    store.transitionInsight(id, 'resolved')

    const row = store.insights({ state: 'resolved' })[0]!
    expect(row.fixSessions.map((f) => f.sessionId)).toEqual(['s1'])
    expect(row.adoptedAt).toBe('2026-06-01T10:00:00Z')
  })

  it('falls back to the state log for adoptedAt when the fix session was pruned', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')
    sight(store, 's1', id)
    store.reconcileFixSightings()

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1') // transcript rotated → session pruned → sightings cascade away
    const row = store.insights()[0]!
    expect(row.state).toBe('adopted')
    expect(row.fixSessions).toEqual([])
    expect(row.adoptedAt).not.toBeNull() // processing time from the log — honest fallback
  })

  it('fix sessions and adoptedAt are cycle-scoped after a reopen', () => {
    const { store } = setup()
    store.persistInsights('det', 1, [mkInsight()])
    const id = insightId('det', '*', 'k1')

    // Cycle 1: fix applied long ago, insight resolved.
    sight(store, 's1', id, '2020-01-01T00:00:00Z')
    store.reconcileFixSightings()
    expect(store.insights()[0]!.adoptedAt).toBe('2020-01-01T00:00:00Z')
    store.transitionInsight(id, 'resolved')

    // Recurrence → reopen. The old fix session is history, not the current fix.
    store.persistInsights('det', 1, [mkInsight()])
    let row = store.insights()[0]!
    expect(row.state).toBe('surfaced')
    expect(row.fixSessions).toEqual([])
    expect(row.adoptedAt).toBeNull()

    // Cycle 2: a new fix session (turn_at after the reopen) becomes the current fix.
    sight(store, 's2', id, '2099-01-01T00:00:00Z', 2)
    expect(store.reconcileFixSightings()).toBe(1)
    row = store.insights()[0]!
    expect(row.state).toBe('adopted')
    expect(row.fixSessions.map((f) => f.sessionId)).toEqual(['s2'])
    expect(row.adoptedAt).toBe('2099-01-01T00:00:00Z')
  })
})

describe('insightEvidence', () => {
  it('returns each occurrence with its note, turn, and session title', () => {
    const { db, store } = setup()
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Add codex adapter', 's1')
    store.persistInsights('det', 1, [
      mkInsight({
        evidence: [
          { sessionId: 's1', turnIdx: 12, note: 'user had to point at the db config' },
          { sessionId: 's2', note: 'user re-supplied the deploy steps' }, // no turn
        ],
      }),
    ])
    const id = insightId('det', '*', 'k1')
    const ev = store.insightEvidence(id)
    expect(ev).toHaveLength(2)
    const s1 = ev.find((e) => e.sessionId === 's1')!
    expect(s1).toMatchObject({ turnIdx: 12, note: 'user had to point at the db config', sessionTitle: 'Add codex adapter' })
    // A -1 turn_idx (session-level evidence) reads back as null.
    expect(ev.find((e) => e.sessionId === 's2')!.turnIdx).toBeNull()
  })

  it('re-detection replaces evidence notes (no stale rows)', () => {
    const { store } = setup()
    store.persistInsights('det', 1, [mkInsight({ evidence: [{ sessionId: 's1', note: 'first' }] })])
    store.persistInsights('det', 1, [mkInsight({ evidence: [{ sessionId: 's2', note: 'second' }] })])
    const ev = store.insightEvidence(insightId('det', '*', 'k1'))
    expect(ev.map((e) => e.note)).toEqual(['second'])
  })
})

describe('persistThemeExtraction prune vs. live insights', () => {
  const THEME = 'recurring-themes:global:live-theme'

  it('does NOT prune a theme that backs a non-dismissed insight, even with no events left', () => {
    const { store } = setup()
    // Theme with one event in s1, surfaced as an insight (signal_key = theme id).
    store.persistThemeExtraction('s1', [{ id: THEME, label: 'Live', type: 'preference' }], [
      { idx: 0, type: 'preference', trigger: 'unprompted', description: 'x', themeId: THEME },
    ])
    store.persistInsights('recurring-themes', 1, [{
      signalKey: THEME, repo: '*', severity: 'low', title: 'Live', description: 'd', evidence: [], count: 3,
      fix: { type: 'behavioral-nudge', label: 'l', content: 'c' },
    }])
    // A re-extract of s1 now yields NO events for the theme (its last event drops).
    store.persistThemeExtraction('s1', [], [])
    // The theme survives because a live insight still backs it (would otherwise orphan).
    expect(store.allThemes().some((t) => t.id === THEME)).toBe(true)
  })

  it('DOES prune a theme with no events and no backing insight', () => {
    const { store } = setup()
    store.persistThemeExtraction('s1', [{ id: 'recurring-themes:global:ghost', label: 'Ghost', type: 'other' }], [
      { idx: 0, type: 'other', trigger: 'unprompted', description: 'x', themeId: 'recurring-themes:global:ghost' },
    ])
    store.persistThemeExtraction('s1', [], []) // drops its only event; nothing backs it
    expect(store.allThemes().some((t) => t.id === 'recurring-themes:global:ghost')).toBe(false)
  })
})

describe('insight first/last-seen from real occurrence times', () => {
  const seen = (db: ReturnType<typeof openDb>, id: string) =>
    db.prepare('SELECT first_seen_at AS first, last_seen_at AS last FROM insights WHERE id = ?').get(id) as { first: string; last: string }

  it('themesWithEvents derives first/last-seen from the events’ message timestamps (min/max)', () => {
    const { store } = setup()
    const THEME = 'recurring-themes:global:t'
    store.persistThemeExtraction('s1', [{ id: THEME, label: 'T', type: 'other' }], [
      { idx: 0, type: 'other', trigger: 'unprompted', description: 'a', themeId: THEME, occurredAt: '2026-06-10T09:00:00Z' },
      { idx: 1, type: 'other', trigger: 'unprompted', description: 'b', themeId: THEME, occurredAt: '2026-07-15T12:00:00Z' },
      { idx: 2, type: 'other', trigger: 'unprompted', description: 'c', themeId: THEME, occurredAt: '2026-06-25T08:00:00Z' },
    ])
    const t = store.themesWithEvents().find((x) => x.id === THEME)!
    expect(t.firstSeenAt).toBe('2026-06-10T09:00:00Z') // earliest
    expect(t.lastSeenAt).toBe('2026-07-15T12:00:00Z') // latest, not extraction order
  })

  it('persistInsights stores supplied first/last-seen instead of the run time', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-05-01T00:00:00Z', lastSeenAt: '2026-07-15T00:00:00Z' })])
    const row = seen(db, insightId('det', '*', 'k1'))
    expect(row.first).toBe('2026-05-01T00:00:00Z')
    expect(row.last).toBe('2026-07-15T00:00:00Z')
  })

  it('falls back to the run time when a detector supplies no occurrence times', () => {
    const { db, store } = setup()
    const before = new Date().toISOString()
    store.persistInsights('det', 1, [mkInsight()]) // no first/last supplied (e.g. S-tier)
    const row = seen(db, insightId('det', '*', 'k1'))
    expect(row.first >= before).toBe(true) // run-time floor, not undefined/epoch
    expect(row.last >= before).toBe(true)
  })

  it('re-persist advances last-seen but never clobbers the original first-seen', () => {
    const { db, store } = setup()
    const id = insightId('det', '*', 'k1')
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-05-01T00:00:00Z', lastSeenAt: '2026-06-01T00:00:00Z' })])
    // A later run sees a NEW latest occurrence; first-seen must stay at the original.
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-05-01T00:00:00Z', lastSeenAt: '2026-07-20T00:00:00Z' })])
    const row = seen(db, id)
    expect(row.first).toBe('2026-05-01T00:00:00Z')
    expect(row.last).toBe('2026-07-20T00:00:00Z')
  })

  it('a re-persist WITHOUT a supplied first-seen keeps the stored one (COALESCE guard)', () => {
    const { db, store } = setup()
    const id = insightId('det', '*', 'k1')
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-05-01T00:00:00Z', lastSeenAt: '2026-06-01T00:00:00Z' })])
    store.persistInsights('det', 1, [mkInsight()]) // no first/last this time
    const row = seen(db, id)
    expect(row.first).toBe('2026-05-01T00:00:00Z') // preserved, not overwritten with run time
  })

  it('keeps the earliest when a re-persist supplies a LATER first-seen', () => {
    const { db, store } = setup()
    const id = insightId('det', '*', 'k1')
    // Rolling-window detectors (cache-miss, context-exhaustion, kitchen-sink) compute
    // their earliest occurrence over a trailing 30 days, so the value they supply
    // marches forward every run. A chronic insight open for months must not keep
    // reporting "first seen ≤30 days ago" — that destroys the origin date.
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-04-01T00:00:00Z', lastSeenAt: '2026-05-01T00:00:00Z' })])
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-06-22T00:00:00Z', lastSeenAt: '2026-07-22T00:00:00Z' })])
    const row = seen(db, id)
    expect(row.first).toBe('2026-04-01T00:00:00Z')
    expect(row.last).toBe('2026-07-22T00:00:00Z') // last-seen still advances
  })

  it('moves first-seen back when the detector finds a genuinely earlier occurrence', () => {
    const { db, store } = setup()
    const id = insightId('det', '*', 'k1')
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-05-01T00:00:00Z', lastSeenAt: '2026-06-01T00:00:00Z' })])
    // Newly-ingested older sessions can reveal the pattern started earlier.
    store.persistInsights('det', 1, [mkInsight({ firstSeenAt: '2026-03-01T00:00:00Z', lastSeenAt: '2026-06-01T00:00:00Z' })])
    expect(seen(db, id).first).toBe('2026-03-01T00:00:00Z')
  })

})

describe('detector_runs — append-only run log', () => {
  const cost = (usd: number, model: string) => ({ inTokens: 100, outTokens: 20, usd, model })

  it('appends one row per run instead of overwriting the prior one', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()], cost(0.4, 'small'))
    store.persistInsights('det', 1, [mkInsight()], cost(0.02, 'small'))
    const rows = db.prepare('SELECT cost_usd FROM detector_runs WHERE detector = ? ORDER BY id').all('det') as Array<{ cost_usd: number }>
    expect(rows.map((r) => r.cost_usd)).toEqual([0.4, 0.02])
  })

  it('sums lifetime spend across runs — an incremental re-run cannot erase the first run', () => {
    const { store } = setup()
    // Detector work is incremental: run 1 pays for the whole corpus, run 2 for a
    // 3-session delta. Reporting only the last run would hide 95% of the spend.
    store.persistInsights('det', 1, [mkInsight()], cost(0.4, 'small'))
    store.persistInsights('det', 1, [mkInsight()], cost(0.02, 'small'))
    expect(store.summary().analysisCostUsd).toBeCloseTo(0.42, 5)
  })

  it('an error run appends its own row and never clobbers the last successful one', () => {
    const { db, store } = setup()
    store.persistInsights('det', 1, [mkInsight()], cost(0.4, 'small'))
    store.persistDetectorError('det', 1)
    const rows = db.prepare('SELECT status, model, cost_usd FROM detector_runs WHERE detector = ? ORDER BY id').all('det') as Array<{
      status: string; model: string | null; cost_usd: number | null
    }>
    expect(rows).toEqual([
      { status: 'ok', model: 'small', cost_usd: 0.4 },
      { status: 'error', model: null, cost_usd: null },
    ])
    // The spend that actually happened survives the error run.
    expect(store.summary().analysisCostUsd).toBeCloseTo(0.4, 5)
  })

  it('detectorRun reports the latest run; lastSuccessfulModel skips over error runs', () => {
    const { store } = setup()
    store.persistInsights('det', 1, [mkInsight()], cost(0.4, 'small'))
    store.persistDetectorError('det', 1)
    expect(store.detectorRun('det')).toMatchObject({ status: 'error', version: 1 })
    // The model whose extractions are actually in the store — not the failed run's null.
    expect(store.detectorLastSuccessfulModel('det')).toBe('small')
  })

  it('lastSuccessfulModel is null for a detector that has only ever errored', () => {
    const { store } = setup()
    store.persistDetectorError('det', 1)
    expect(store.detectorLastSuccessfulModel('det')).toBeNull()
  })
})
