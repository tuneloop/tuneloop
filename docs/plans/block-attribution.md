# Implementation Plan — Block-Level Attribution (Handling Long Sessions)

Status: design settled, not started.
Product doc of record: `~/projects/newCo-X/docs/prds/handling_long_sessions.md` (left as-is — this plan
is the engineering elaboration, not a replacement).
Related design docs: `cost_per_shipped_artifact.md`, `headline_metrics.md`, `prd_features_shipped.md`, `gaps.md`.

## Problem

A session is no longer the unit of work. Long sessions ship multiple PRs / advance multiple features /
move through several use-cases, which breaks every place that assumes "one session ≈ one unit":

- **P1** Artifacts view charges each PR the whole session cost.
- **P2** Cost-per-shipped-artifact KPI uses whole-session cost even when a session shipped one feature and
  abandoned another (the burn "converted spend" sub-band has the same flaw).
- **P3** Spend-by-`use_case` is presence-inflated (a session with two use-cases charges its full cost to each).
- **P5** Spend time-bucketing dates a multi-day session at its start.

We split each session into a **deterministic partition of contiguous blocks** and attribute cost at block
grain. (P4 — `success`/`autonomy`/`complexity` — stays session-level by design; see PRD.)

## Core design decisions (these revise the design-of-record — keep the rationale)

1. **Block = the unit of attribution. The partition is deterministic; the LLM only labels it.**
   Block boundaries and each block's cost are computed without an LLM. The model adds a `use_case` label and
   a feature pointer. So a model miss is a *quality* degradation (an unlabeled block → an `(unclassified)`
   bucket), never a *correctness* break — cost always reconciles.

2. **One shared `seq` index over main-thread events**, carried as **normalized-model metadata** (a field on
   the `Event`, persisted in the session blob), is the coordinate the partition is defined in. It is the
   **main-thread** index (sidechains are clumped per-file by `merge.ts`, not nested) and is assigned
   **post-merge** (the merged array is the canonical order), so it is vendor-neutral and visible to every
   processor via `ctx.session`. This works cleanly because Claude Code emits each tool call as its own
   tool-only assistant message; the partition logic still treats a block as a *range of messages* so it
   survives a harness that puts several tool calls in one message.

3. **Block segmentation is a PROCESSOR, not ingest** — see "Responsibilities & extensibility" below. It owns
   the `blocks` table plus **join tables** (`block_usage`, `block_tool`) that map each `usage_facts.idx` /
   `tool_calls.idx` to its block. `usage_facts` / `tool_calls` stay untouched ingest substrate; their `idx` is
   a content-deterministic ordinal, so the join references survive a wholesale re-ingest.

4. **Two-layer attribution maps to the no-key / key experience:**
   - *Deterministic (no LLM):* `segment-blocks` builds the partition + membership; `outcomes-git` emits
     block→PR/commit links. **Cost-per-PR is exact and reproducible the moment you run `analyze` with no key**
     — the OSS default, since features need a manual "mark shipped".
   - *LLM (folded into `enrich-session`):* `use_case` labels + block→feature links. Only the *label/feature*
     is model-derived; boundaries and cost stay deterministic.

5. **LLM output is runs, not per-block labels.** The model returns contiguous **runs** over block indices, so
   output scales with the number of *transitions* (few), not block count (many) — robust for long sessions.
   - `use_case_runs`: `[{from,to,use_case}]`, must tile `[0,N-1]`.
   - `feature_runs`: `[{from,to,feature}]`, **sparse** (chores/research belong to no feature), `feature` is an
     **index into the session-level feature palette** (the model can't know server-minted derived ids).
   - Feature *creation/parenting* stays a session-level concern (the existing `features` + `feature_revisions`
     outputs); runs only *reference* the palette. Keeps dedup/repo-isolation in one place; a garbled run can't
     corrupt the taxonomy.

6. **`block` is a new grain between `session` and `usage`/`tool_call`.** Ancestry: `session ⊃ block ⊃ {usage,
   tool_call}`. `cost` stays a single usage-grain measure (reconciles everywhere); `use_case` migrates to block
   grain. A usage-grain measure grouped by a block-grain facet is valid (block is an ancestor of usage); the
   `usage ↔ tool_call` sibling reject (e.g. cost × skill) is preserved.

7. **The KPI numerator moves to block cost — and the unique-session hack dissolves.** Blocks partition the
   session, and each block links to ≤1 artifact of a given kind, so no `DISTINCT` is needed and the cost doc's
   accepted fan-out residual disappears. PR numerator is fully deterministic; feature numerator is LLM-derived
   (same model-dependence class as today's feature linkage — not new), with a graceful fallback to the old
   session-level number when the feature layer hasn't run.

## Responsibilities & extensibility (why segmentation is a processor)

The three roles, and where the block work lands:

- **Adapter** (`src/adapters/*`) — the *only* vendor-aware code. Produces the normalized `Session`: canonical
  `action` per tool call, `isSidechain`, timestamps, per-message usage, `SubagentMeta.toolUseId`.
- **Ingest** (`ingestSession` + `computeSessionCost`) — the atomic substrate every reader depends on
  (`sessions`, `usage_facts`, `tool_calls`, blob). Untouched by this work.
- **Processors** — everything else derived from the normalized model, each independently versioned and owning
  its rows. **Precedent:** `files-touched` is a pure, dependency-free function of the session and is a
  processor — so "pure derived fact" does *not* imply "ingest." A deterministic block partition is the same
  kind of thing → a processor.

Why processor beats ingest here, concretely:

- A `block_idx` **column on `usage_facts`** would be a split-owned column on a wholesale-rebuilt table → wiped
  on every re-ingest, restored only on a processor cache-miss = the re-ingest-cascade-wipe footgun this repo
  already hit. The join-table approach sidesteps it (`usage_facts.idx` is content-stable).
- Re-segmenting later (the deferred LLM sub-cut v2) is a **processor version bump**, not a `PARSE_VERSION`
  bump that needlessly rebuilds tokens for every session.

**Extensibility (Codex as the next harness):** segmentation reads **only** the normalized model (`seq`,
canonical `action`, `isSidechain`, the subagent spawn link), never raw vendor data. So **adding Codex = writing
the Codex adapter**; `segment-blocks` then works unchanged, exactly like `files-touched`/`outcomes-git`. The
vendor-specific risks all live at the adapter line: (1) commit/PR detection keys on `action='shell'` + command
strings, so it works iff the adapter surfaces shell commands the same way; (2) the subagent rollup needs
`SubagentMeta.toolUseId` populated (or Codex has no sidechains and there's nothing to roll up); (3) if Codex
emits multiple tool calls per message, the partition must stay message-range based (it does). Keeping
segmentation above the adapter line, in normalized-model terms, is what keeps it harness-agnostic.

## The master invariant (gates correctness end to end)

```
Σ usage_facts.cost_usd (joined to its block via block_usage), grouped by block  ==  sessions.cost_usd   (per session)
AND  every usage_facts row appears in exactly one block_usage row (exhaustive + non-overlapping partition)
```

Non-overlap is enforced by the `block_usage` PK `(session_id, usage_idx)`; **exhaustiveness must be asserted**
(no uncovered `usage_facts.idx`). `block_usage` must cover **every** usage row:
- main-thread message → the block whose `[start_seq,end_seq]` contains its `seq`;
- sidechain message → the block containing its spawning `Task` call (`agentId → SubagentMeta.toolUseId →` the
  Task tool_use's `seq → block`);
- orphan sidechain (workflow subagent, `toolUseId` absent) → nearest preceding main-thread block by timestamp.

The partition is produced by a single shared pure function **`deterministicBlocks(session)`** so that
`segment-blocks` (persists it), `outcomes-git` and `enrich-session` (attach links/labels to `block_idx`), and
the read path all agree on indices without cross-processor store reads.

---

## Phases (all in scope, including the feature layer; each lands independently)

### Phase 1 — `seq` + block tables (substrate, no behavior change)

- `src/core/model.ts`: add `seq?: number` to `BaseEvent` (main-thread events only).
- New normalization step **after** `mergeSessions` (`src/core/merge.ts`): assign `seq` over the final ordered
  `events`, main-thread (`!isSidechain`) only. Do **not** assign in `parse.ts` (per-file → incoherent for
  resume/sidechain multi-file sessions). `seq` is serialized in the session blob (persisted).
- New `src/core/blocks.ts`:
  - `deterministicBlocks(session): Block[]` — pure partition. Cut points (in `seq` order): session start;
    each real main-thread user turn (reuse `userTurns`/`isSyntheticUser` from `core/turns.ts`); the position
    **after** each `git commit` / `gh pr create` / `gh pr merge` tool call. Each block: `{idx, startSeq,
    endSeq, boundaryKind, tsStart, tsEnd}`.
  - `blockMembership(session, blocks): { usage: Array<{usageIdx,blockIdx}>; tool: Array<{toolIdx,blockIdx}> }`
    — applies the sidechain rollup + orphan fallback rules so every `usage_facts.idx` / `tool_calls.idx` maps
    to exactly one block.
- `src/store/db.ts` — **single schema migration, `SCHEMA_VERSION 4 → 5`** (no `ALTER` on `usage_facts` /
  `tool_calls`):

```sql
CREATE TABLE IF NOT EXISTS blocks (
  session_id    TEXT,
  idx           INTEGER,        -- 0-based main-thread block ordinal
  start_seq     INTEGER,        -- inclusive
  end_seq       INTEGER,        -- inclusive
  boundary_kind TEXT,           -- 'user_turn' | 'commit' | 'pr_create' | 'pr_merge' | 'session_end'
  ts_start      TEXT,
  ts_end        TEXT,
  producer      TEXT,
  PRIMARY KEY (session_id, idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_blocks_session ON blocks(session_id);

-- block membership. PK on (session_id, usage_idx) enforces non-overlap (a usage row → one block).
CREATE TABLE IF NOT EXISTS block_usage (
  session_id TEXT, block_idx INTEGER, usage_idx INTEGER,   -- usage_idx → usage_facts.idx
  PRIMARY KEY (session_id, usage_idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_usage_block ON block_usage(session_id, block_idx);

CREATE TABLE IF NOT EXISTS block_tool (
  session_id TEXT, block_idx INTEGER, tool_idx INTEGER,    -- tool_idx → tool_calls.idx
  PRIMARY KEY (session_id, tool_idx),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_tool_block ON block_tool(session_id, block_idx);

CREATE TABLE IF NOT EXISTS block_annotations (   -- per-block labels (parallels `annotations`)
  session_id TEXT, block_idx INTEGER, processor TEXT, key TEXT, value TEXT,  -- value = json
  PRIMARY KEY (session_id, block_idx, processor, key),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS block_artifacts (     -- block → PR/commit/feature
  session_id TEXT, block_idx INTEGER, artifact_id TEXT, role TEXT, source TEXT, confidence REAL, producer TEXT,
  PRIMARY KEY (session_id, block_idx, artifact_id, role),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_block_artifacts_artifact ON block_artifacts(artifact_id);
```

  > Cost and timing are **derived** via `block_usage ⋈ usage_facts` (consistent with "facts only, metrics at
  > read time"); no `cost_usd` denorm on `blocks`. Add one later only if profiling demands it.

- **Bump `PARSE_VERSION` (currently `4`, `src/adapters/claude-code/parse.ts:21`)** — `seq` is now part of the
  normalized output persisted in the blob, so the parse-version-aware gate must re-ingest to backfill it.
- **Verify:** on a WAL-safe copy of `~/.tuneloop/tuneloop.sqlite`, schema migrates; tables exist and are empty.

### Phase 2 — `segment-blocks` processor + block→PR/commit links (deterministic, no LLM)

- `src/processors/segment-blocks.ts` — new **static** processor (`kind:'static'`, `needs:{}` → always runs).
  Reads `ctx.session`, calls `deterministicBlocks` + `blockMembership`, emits `blocks` + `block_usage` +
  `block_tool`. Versioned independently (re-segment = bump this version, no `PARSE_VERSION` churn).
- `src/core/processor.ts`: add `blocks?`, `blockUsage?`, `blockTool?`, `blockArtifacts?`, `blockAnnotations?`
  to `ProcessorResult` (+ input types in `src/store/types.ts`).
- `src/store/store.ts` `persistResult`: write + **per-producer replace** the block tables (delete this
  producer's rows, insert new) — same pattern as `session_artifacts`.
- `src/processors/outcomes-git.ts`: `requires: ['segment-blocks']`; recompute `deterministicBlocks(session)`,
  map each `gh pr create`/`gh pr merge`/`git commit` tool call's `block_idx`, and emit `block_artifacts`
  (block→PR/commit) using the **same deterministic artifact id** it already mints for the session→PR link.
- **Verify:** every `usage_facts.idx` is covered by exactly one `block_usage` row (master invariant);
  `Σ cost` by block reconciles to `sessions.cost_usd`; every PR artifact has ≥1 block link; each block → ≤1 PR.

### Phase 3 — register `block` as a grain

- `src/core/facets.ts`: `FacetSource += 'block'`; `Grain += 'block'`; replace flat `grainOf` with a
  `DEPTH`/ancestry model (`session:0, block:1, usage:2, tool_call:2`). `src/core/measures.ts` `aliasFor`:
  `block → 'b'`.
- `src/store/store.ts` `breakdown` (~`:1184`): relax the guard from equality to **ancestor-or-equal** — a
  facet at grain `gf` is valid for a measure at grain `gm` iff `gf` is an ancestor of (or equal to) `gm`.
  Preserve the `usage ↔ tool_call` sibling reject (still `incompatible grain`).
- `facetGroupExpr` (~`:2013`) and `facetPredicate` (~`:1090`): add a `'block'` branch.
  - `facetGroupExpr` needs the **measure's anchor alias** (`u`/`t`) to bridge through membership:
    `JOIN block_usage bu ON bu.session_id=u.session_id AND bu.usage_idx=u.idx
     JOIN block_annotations ba ON ba.session_id=bu.session_id AND ba.block_idx=bu.block_idx AND ba.key='<key>'`,
    group on `ba.value`. (For a `tool_call`-anchored measure, bridge via `block_tool`.)
  - `facetPredicate` (session-scoped, alias `s`): `EXISTS (SELECT 1 FROM block_annotations ba WHERE
    ba.session_id=s.id AND ba.key=? AND ba.value=?)` — same shape as the `model`/`skill` EXISTS.
- **Verify:** `cost` × a (hand-inserted) block facet returns a grouped result; `cost` × `skill` still rejects.

### Phase 4 — LLM run-encoding in `enrich-session` (use_case + feature layer)

- `src/core/blocks.ts`: `blockSpine(session): string` — the complete numbered block digest for the prompt
  (every block: idx, truncated opening user turn ~200 chars, compact action summary as counts). **Not
  truncated** (idx labels must map); this replaces the lossy `userSpine` for the segmentation half only.
- `src/processors/enrich-session.ts` (`requires: ['segment-blocks']`):
  - Prompt: add the block spine + instructions for the two run arrays.
  - Schema additions:
    ```jsonc
    "use_case_runs": [ { "from": 0, "to": 4, "use_case": "<one of USE_CASES>" } ],  // tiles [0,N-1]
    "feature_runs":  [ { "from": 0, "to": 4, "feature": 0 } ]                       // sparse; "feature" = index into "features"[]
    ```
    `features` / `feature_revisions` stay as-is (the palette + taxonomy maintenance).
  - **Raise `maxTokens`** off `1500` (sized for session-only output).
  - **Run validation/fill** (mirror existing `oneOf`/`sanitizeList` discipline), using the same
    `deterministicBlocks(session)` to know `N`:
    - `use_case_runs`: clamp `from/to` to `[0,N-1]`; tile in order; gap between two runs of the *same*
      use-case → fill with it, else `(unclassified)`; overlaps → first-wins.
    - `feature_runs`: enforce **non-overlapping**; ignore out-of-range `feature` palette index; sparse is fine.
  - Emit `blockAnnotations` (one `use_case` per block, expanded from the runs) and `blockArtifacts`
    (block → feature, `source='derived'`, resolved via the palette index → the feature's concrete id).
  - **`use_case` facet migrates `source: 'annotation'` → `'block'`** in `enrichSession.facets`. Keep a
    session-level `use_case` view as the **union rollup** of block labels (back-compat for filters/detail).
  - Bump `enrichSession.version` (`9 → 10`).
- **Verify (with a key, on a copy):** runs tile `[0,N-1]`; `cost` by `use_case` Σ-of-series **== total spend**
  (no inflation); `feature_runs` sparse and non-overlapping; an unlabeled block lands in `(unclassified)`.

### Phase 5 — read path rewired to blocks

- `Store.costPerArtifact(kind, from, to)` — numerator becomes `SUM(usage_facts.cost) for usage rows whose
  block links (block_artifacts) to a kind artifact completed in [from,to]`, **no `DISTINCT`**:
  ```sql
  SELECT SUM(u.cost_usd)
  FROM usage_facts u
  JOIN block_usage bu ON bu.session_id=u.session_id AND bu.usage_idx=u.idx
  JOIN block_artifacts ba ON ba.session_id=bu.session_id AND ba.block_idx=bu.block_idx
  JOIN artifacts a ON a.id=ba.artifact_id
  WHERE a.kind=? AND a.completed_at >= ? AND a.completed_at < ?
  ```
  Feature path: prefer `block_artifacts` (derived feature links); **fall back** to the old `session_artifacts`
  whole-session sum when no block→feature links exist (feature layer not run). Denominator unchanged.
  Preserves "numerator includes pre-window spend".
- `Store.costCurves(kind, bucket)` — anchor burn on `usage_facts` dated at `u.ts` (finer; P5); `burn_shipped`
  = same rows restricted to `EXISTS (block_usage ⋈ block_artifacts → artifact completed)`. Only converted
  blocks fill the sub-band; `burn` total unchanged. `burn_shipped` and the KPI numerator are now the **same
  granularity** (both block-linked) — no divergence.
- `Store.spendOverTime(q)` / `Store.breakdown` — `use_case` resolves at block grain via `usage_facts.idx →
  block_usage → block_annotations` (Phase 3 plumbing); `presenceInflated` becomes `false` for `use_case`.
  Optionally date at `u.ts`.
- `Store.kpis(from,to)` — the cost-per-artifact tiles pick up the updated `costPerArtifact`; the other headline
  numbers (total spend, sessions, success rate) are session-grain and unchanged.
- `sessionList` facet filter + drawer detail for `use_case` — resolve via the `block_annotations` EXISTS.
- **Verify:** a session that shipped feature A and abandoned feature B charges only A's blocks to A's KPI;
  `burn_shipped` greens only A's blocks; `Σ use_case series == total spend`; cost-by-model unchanged.

### Phase 6 — dashboard surface (+ optional block navigation)

- Drop the `use_case` presence-inflation caption (it now reconciles).
- Cost-per-PR / cost-per-feature tiles + burn sub-band reflect block-precise numbers.
- **Optional / separable (PRD "session navigation"):** artifact-based jumping in the transcript viewer (jump
  to the first block matching a PR/feature) using `blocks.start_seq` → transcript position. Nice UX, not
  required for metric correctness — schedule after the metric work lands.

---

## Landmines (most have bitten this repo before)

- **Two version bumps, both required:** `SCHEMA_VERSION` (4→5) for the new tables, and `PARSE_VERSION` to
  backfill `seq` into existing blobs. After deploying, re-run `analyze` (rebuilds blocks via `segment-blocks`,
  which is new → cache-miss), then re-run with a key to regenerate block annotations.
- **`deterministicBlocks` must be a pure function of the normalized session.** `block_idx` values must be
  reproducible, or `block_usage`/`block_artifacts`/`block_annotations` references dangle across re-runs. All
  three producers + the read path derive indices from this one helper.
- **`block_usage` must be exhaustive.** Non-overlap is PK-enforced; exhaustiveness is not — assert it, or
  uncovered `usage_facts` rows silently drop out of block-grouped sums and the Σ-invariant breaks. The
  orphan-sidechain fallback exists for this.
- **`usage_facts.idx` stability is now load-bearing** — the join tables reference it. It is a
  content-deterministic ordinal today; keep it so.
- **Cascade-wipe:** `ingestSession` already UPSERTs `sessions` (no `ON DELETE CASCADE` fire), so processor
  block tables survive an unchanged-hash re-ingest. Don't reintroduce `INSERT OR REPLACE` on `sessions`.
- **WAL when copying the live store for tests:** copy `tuneloop.sqlite` + `-wal` + `-shm` together, or the copy
  is "database disk image is malformed".

## Verification harness

- The master Σ invariant + exhaustiveness (Phase 2) is the foundation — assert after every phase.
- Per read number, a reconciliation test (Phase 5 verify bullets).
- Run end-to-end on a throwaway copy of `~/.tuneloop/tuneloop.sqlite` (real store untouched); `npm run typecheck` +
  client `node --check` clean; eyeball the dashboard (the user verifies UI in-browser).

## Explicitly deferred (write down so they aren't relitigated)

- **LLM sub-cutting within a deterministic block** (PRD's "a block may need to be split for use_case"): v1
  labels the fixed deterministic blocks; the model does not move boundaries. Because segmentation is a
  processor, this is a future version bump on `segment-blocks` (+ a richer `enrich-session` run), not a
  re-architecture. Revisit only if real data shows deterministic blocks are too coarse for autonomous runs.
- **Interleaved-PR misattribution:** the deterministic boundary assumes work is sequential between commit/PR
  actions (true for the in-one-go style). Genuinely interleaved PRs misattribute; the sub-cut layer above
  would address it.
- **Segmenter / judge-model pinning** (`gaps.md` P1): the *feature* numbers are LLM-derived (as they already
  are). Pin the model + version the prompt before these go in front of a customer. Pre-existing debt, not new.
- **Transitive block→feature** (PR→ticket→epic): derivable once ticketing is connected (the paid product),
  which would finally populate `artifact_links`. OSS stays LLM-only via `feature_runs`.
