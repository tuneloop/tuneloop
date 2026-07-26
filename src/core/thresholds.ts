/**
 * Detector thresholds shared between the detectors that own the concept and the
 * SQL views that classify from the same facts. A view takes no parameters, so a
 * literal buried in `db.ts` would silently drift from the detector; keeping the
 * single definition here and interpolating it into the view SQL (see
 * `buildUsageViews` in `../store/db`) is what stops the two from disagreeing.
 *
 * These are absolute, model- and harness-agnostic gates (per-model context-window
 * normalization is explicitly deferred). Changing a value here changes both the
 * detector and the view on the next `openDb` — the views are recreated
 * unconditionally, so an existing store picks up the new definition.
 */

// --- context-exhaustion (compaction) -------------------------------------------
// A compaction is a turn where occupancy drops >60% (occ <= 0.4 × prev) from a
// prior turn of at least PEAK_FLOOR tokens. Occupancy is the whole prompt and a
// conversation is append-only, so it only grows turn to turn; a drop this large
// means content left the prompt — a removal event (auto-compaction, or a manual
// /compact//clear, which is counted the same). The floor is a small-session noise
// gate; both thresholds are absolute, applied uniformly across models and harnesses.
export const DROP_SHARE = 0.4 // occupancy must fall to at most 40% of the previous turn's (a >60% drop)
export const PEAK_FLOOR = 100_000 // ...from a turn at least this large

// --- cache-miss ----------------------------------------------------------------
export const MIN_CONTEXT_TOKENS = 10_000 // below this the dollars are noise — our floor, not a provider rule
export const HIT_READ_SHARE = 0.5 // a hit reads back at least this share of its prior context
// New context under half the previous one is a rewrite (compaction/rewind),
// not a cold cache — neither hit nor miss.
export const SHRUNK_CTX_SHARE = 0.5
