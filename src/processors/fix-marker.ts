import { registerProcessor } from '../core/registry'
import type { Processor } from '../core/processor'
import { extractFixMarkers } from '../core/fix-prompt'
import { isSyntheticUser, stripReminders } from '../core/turns'
import type { FixMarkerSightingInput } from '../store/types'

/**
 * Sights `tuneloop-fix: <insight-id>` markers in main-thread real user turns —
 * the trace a pasted fix-prompt leaves in its fix session.
 *
 * Records facts only; the reconcile step in analyze applies the lifecycle
 * transitions. The split matters: a fix session can be scanned before its
 * insight exists (store rebuild — processors run before detectors re-mint
 * insights), and a fact that can't be interpreted yet must not be lost.
 *
 * Real user turns only: agent output may quote a marker and sidechain "user"
 * turns are parent-authored — neither is evidence the user applied the fix.
 * Known gap: a marker arriving via tool output (a skill fetching the
 * fix-prompt) is not sighted.
 */
export const fixMarker: Processor = {
  name: 'fix-marker',
  version: 1,
  kind: 'static',
  run(ctx) {
    const { session } = ctx
    const sightings: FixMarkerSightingInput[] = []
    const seen = new Set<string>()
    for (const ev of session.events) {
      if (ev.kind !== 'user' || ev.isSidechain || ev.seq == null) continue
      // Scan the reminder-stripped text: a marker quoted inside an injected
      // <system-reminder> block is not the user pasting a fix-prompt.
      const text = stripReminders(ev.text)
      if (!text || isSyntheticUser(text)) continue
      // No event timestamp at all → skip: stamping scan time as the "fix applied"
      // date would wrongly place an old paste in the current cycle.
      const turnAt = ev.ts ?? session.startedAt
      if (!turnAt) continue
      for (const id of extractFixMarkers(text)) {
        if (seen.has(id)) continue // one sighting per (session, insight) — matches the PK
        seen.add(id)
        sightings.push({ insightId: id, seq: ev.seq, turnAt })
      }
    }
    // Always emit the field (even empty) so persistResult's wipe-and-replace
    // clears stale sightings when a re-scanned session no longer has the marker.
    return { fixMarkerSightings: sightings }
  },
}

registerProcessor(fixMarker)
