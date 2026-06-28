# PR ↔ review-session linkage

Status: **implemented** on branch `pr-review-linkage` (off `main`). Typecheck + tests green.

## What was built (differs from the original plan below — read this first)

We chose **Design Y, not X**, and fixed a store bug the plan had only designed around:

- **`src/processors/github-pr.ts` (new)** — shared `parsePrRefs(session)`,
  `prArtifactBase(ref)`, `enrichPrArtifact(sh, base, cwd)`, and `stripInertRegions`.
  `parsePrRefs` detects create / merge / read PRs **intentfully**: identity comes from
  the command target, a web-fetch url, an MCP input, or a human-prompt URL — it does
  NOT scan unrelated tool output for stray URLs (the old false-positive trap). A read
  with no resolvable `owner/repo/num` (bare `gh pr diff 21`) is skipped.
- **`outcomes-git.ts`** — refactored to use the shared helpers; behavior unchanged
  (still only attributes create/merge here). Re-exports `stripInertRegions` for its test.
- **`enrich-session.ts`** owns the whole `reviewed` flow (Design Y): for a PR read
  **inside a block the LLM labeled `review`** (block-grain gate via `blockMembership` +
  the per-block `use_case` array), excluding self-created PRs, it ensure-enriches the
  PR artifact with the shared `gh` helper and emits `session_artifacts role:'reviewed'`
  (`source:'derived'`, `confidence:0.6`) + a `pr_reviewed` outcome. A human-pasted PR
  link (no owning block) falls back to "the session reviewed somewhere". **Version
  bumped 12 → 13**, which re-runs LLM enrichment on every existing session (accepted
  one-time cost). No `requires:['outcomes-git']` — enrich writes the artifact itself.
- **`store.ts`** — the non-feature artifact upsert is now a **field-merging**
  `ON CONFLICT DO UPDATE` (COALESCE), with a `CASE` guard so a stub `open` can't
  overwrite a terminal `merged`/`closed`. Fixes the latent stub-clobber bug for ALL PR
  writers (including the existing created/merged path) and is what makes Design Y safe.
  No `outcomes-git` read-PR creation and no prune dependency — so X's wasted
  `gh pr view` calls on never-reviewed PRs and its transient rows are avoided entirely.
- **`types.ts`** — `SessionArtifactRole` gains `'reviewed'`.
- **Tests** — `github-pr.test.ts` (intentful detection incl. incidental-URL rejection,
  num+repo reads, MCP/web/human-prompt), `enrich-session.test.ts` (review-block link,
  self-created exclusion, non-review skip), `store.test.ts` (stub doesn't clobber; a
  real status transition still applies).

Why Design Y over the plan's leaning-X: `enrich-session` already writes artifacts
(features), so "the reviewer must never touch `artifacts`" was never a real invariant;
and the COALESCE store fix removes the clobber hazard that motivated X's ownership
split. Y does strictly less work (only enriches PRs it actually links).

### Follow-up shipped: block-grain review cost + "PRs reviewed" graph

Built on top of the above (enrich-session `version: 14`):

- **Block-level review links.** `enrich-session` now also emits a `block_artifacts`
  row (`role:'reviewed'`) for the review block(s) where a PR was read. So a reviewed
  PR's cost attributes to the review block only — not the whole session. (A PR read
  only via a human-pasted link, with no tool-read block, keeps just the session link
  and falls back to whole-session cost — a pure-review session IS the review.)
- **Per-PR total cost = production + review.** The PR-table cost (`artifactList`)
  sums all block roles, so a PR that was built *and* reviewed shows prod + review.
  No query change was needed there — it falls out of the new block links.
- **"Cost per shipped PR" stays production-only.** `costPerArtifact`, `costPeriod`,
  and the `costCurves` throughput/shipped-spend now carry a "produced by this store"
  guard: a PR whose only link is `reviewed` (a teammate's PR you reviewed) is NOT
  counted as shipped, and reviewed block cost is excluded from production cost. Without
  this, reviewing a teammate's merged PR would have silently inflated the headline KPI.
- **New "PRs reviewed" graph.** `costCurves` returns a `reviewed` series (distinct PRs
  reviewed per bucket, dated at REVIEW time via the `pr_reviewed` outcome — PRs only).
  Exposed through `/api/cost-artifact` and rendered as a throughput curve directly
  below "PRs shipped" in the Cost-per-merged-PR detail view (`costArtifact.ts`).
- **Tests:** `store/review-cost.test.ts` (production-only count/cost, block-attributed
  review cost, prod+review total, reviewed series), plus a block-link assertion in
  `enrich-session.test.ts`.

The original plan (Design X leaning) is preserved below for context.

---

# Original plan (superseded by the section above)

Status: **planned, no code written.** Branch: `pr-review-linkage` (off `main`).

## Goal

aivue today links a PR to the session that **created/merged** it. We want to also
link a PR to the session(s) that **reviewed** it — a new `reviewed` relationship —
so the dashboard can answer "who reviewed PR X" and "what did reviewing cost."

**Scope: Layer 2 only (derived).** Link a session to a PR as `reviewed` when the
session (a) has work classified `use_case = 'review'` and (b) read that PR's
diff/contents. Explicit `gh pr review` posting (Layer 1) and block-grain review
**cost** are deferred follow-ups.

## Relevant current state (context)

- **PR detection** lives in `src/processors/outcomes-git.ts`. It only fires on
  `gh pr create|merge` (shell) or an MCP tool named `*pull_request*` +
  `create|merge|update`. It upserts a PR artifact (natural key
  `pr:owner/repo:num`), `gh pr view`-enriches it (title/state/mergedAt/diff/author),
  links the session `role:'created'`, and emits `pr_created`/`pr_merged` outcomes.
  It **deliberately ignores** bare PR URLs in read/fetch output (past false-positive fix).
- **`use_case`** is block-grain, produced by the LLM in `src/processors/enrich-session.ts`
  and stored in `block_annotations` (key `use_case`). `USE_CASES` currently =
  `['plan','implement','debug','research','review','docs','other']` — `review` exists.
- **Processor order:** registration order is `segment-blocks → files-touched →
  outcomes-git → enrich-session` (`src/processors/index.ts`); the runner
  (`src/core/runner.ts` `orderProcessors`) topo-sorts by `requires`. `enrich-session`
  only `requires: ['segment-blocks']`, so it runs after `outcomes-git` **only by
  registration tiebreak, not by an explicit dependency.**
- **Processors have no store access.** `ProcessorContext = { session, log, llmEnabled,
  llm, existingFeatures, sh }`. A processor returns a `ProcessorResult`; the runner
  persists it per-`producer` (delete-then-insert → idempotent). So a *separate*
  review processor could not read the `use_case` that enrich-session just wrote.
- **Tables** (`src/store/db.ts`):
  - `artifacts(id PK, kind, repo, ident, owner, title, status, completed_at,
    complexity, parent_artifact_id, producer, …)` — PR id = `pr:owner/repo:num`.
  - `session_artifacts(session_id→sessions FK, artifact_id [NO FK], role, source,
    confidence, producer)` PK `(session_id, artifact_id, role)`.
  - `block_artifacts(… block_idx … artifact_id [NO FK], role, …)` — block-grain.
  - `artifact_links(from_id, to_id, relation, …)` — artifact↔artifact.
  - `outcomes(session_id→sessions FK, type, artifact_id [NO FK], ts, producer)`.
  - **No FK on `artifact_id`** anywhere — a relationship may reference a missing
    artifact with no error (it just dangles → PR invisible in joins).
  - Artifact upsert is `INSERT OR REPLACE` (whole-row) — a stub write clobbers a
    richer row, so any writer must write the fully-enriched artifact, not a stub.
  - `pruneOrphanArtifacts()` deletes non-`user` artifacts with no `session_artifacts`
    link and no `artifact_links` — **link-based, not producer-based** (self-cleaning).
  - `SessionArtifactRole = 'created' | 'edited' | 'contributed'`.

## The gate (Layer 2)

Link session → PR `reviewed` when ALL hold:
1. The session has ≥1 block with `use_case === 'review'` (from `parsed.use_case_runs`
   in enrich-session — no store read needed).
2. The session **read** that PR (`kind: 'read'`): `gh pr view`/`gh pr diff`, MCP
   `get_pull_request*`, a web fetch of the PR URL, or the PR URL in a genuine human
   prompt — with **resolvable** `owner/repo/num`.
3. The session did **not** create/merge that PR (self-review exclusion).

## Proposed solution

**Do the linkage inside `enrich-session`** (it already has `use_case`, `session.toolCalls`,
`session.events`, and `ctx.sh` in hand — no runner/context change). Keep artifact
ownership out of it.

### Ownership split (so the reviewing session never writes the `artifacts` table)
- **`outcomes-git` owns `artifacts`.** Extend it to also detect **read** PRs
  (resolvable identity only) and create + `gh`-enrich those artifact rows, in
  addition to today's created/merged. (No link for read-only PRs — just the row.)
- **`enrich-session` owns only the `reviewed` relationship.** Gated on the rule
  above, it emits `session_artifacts { role:'reviewed', source:'derived',
  confidence:~0.6 }` + a `pr_reviewed` outcome, referencing the natural key. It
  never touches `artifacts`.
- Make ordering explicit: add `requires: ['outcomes-git']` to `enrich-session` so
  the artifact exists before the relationship references it (no FK → otherwise the
  link dangles and the PR is invisible, silently).

### Wrinkle 1 — PR identity extraction (`parsePrRefs`, shared helper)
Resolve **only** to `owner/repo/num`, else skip. Priority:
1. Full PR URL `https://github.com/(owner)/(repo)/pull/(num)` in: human prompt text
   (machinery filtered), `tool.target.command`, `tool.result.raw`, MCP `tool.input`.
2. `gh pr <view|diff|create|merge|review|checkout|comment> (num) … --repo (owner)/(repo)`.
3. Bare number (`gh pr diff 21`, no `--repo`, no URL) → **skip** (cwd gives repo
   basename but no owner).
Dedupe by `pr:owner/repo:num`; tag `kind` (`create`/`merge` vs read-ish `view`/`diff`).

### Wrinkle 2 — artifact ownership (decided: reviewing session writes relationships only)
Resolved by the ownership split above. **One open decision** on *how* the read-PR
artifact gets created:
- **Design X (recommended, leaning):** `outcomes-git` creates+enriches artifacts for
  **all** resolvable read PRs. Ones never reviewed/created end up unlinked →
  `pruneOrphanArtifacts` deletes them. Cost: an extra `gh pr view` per viewed PR +
  transient rows. Clean ownership; enrich stays purely relational.
- **Design Y (alternative):** `enrich-session` does a **non-destructive**
  `INSERT … ON CONFLICT DO NOTHING` to ensure the artifact exists only for PRs it
  actually links. Avoids wasted enrichment, but is technically "the reviewer touching
  `artifacts`" (harmlessly) and needs a new non-clobbering upsert path.
- **TODO: confirm X vs Y before implementing.**

## Implementation steps
1. `src/processors/github-pr.ts` (new): `parsePrRefs(session)` + `enrichPrArtifact(sh, base)`,
   refactored out of `outcomes-git.ts`. Refactor `outcomes-git` to use them (no behavior change).
2. [Design X] Extend `outcomes-git` to create+enrich artifacts for resolvable **read** PRs
   (no link).
3. `src/store/types.ts`: add `'reviewed'` to `SessionArtifactRole` (no migration — TEXT,
   already part of the `session_artifacts` PK so `created` + `reviewed` coexist).
4. `src/processors/enrich-session.ts`: after parsing, if a `review` block exists, derive
   reviewed read-PRs (shared parser) minus self-created, emit `session_artifacts`
   `role:'reviewed'` + `outcome 'pr_reviewed'`. Add `requires: ['outcomes-git']`. Bump
   `version` 12 → 13 (so existing sessions re-run).
5. Test: fixture session (review `use_case` + `gh pr diff` + prompt URL) asserts the
   `reviewed` link is created; a self-created PR is **not** double-linked; an
   owner-unknown read is skipped.

## Open questions / deferred
- **Confirm Design X vs Y** (the only blocking decision).
- Block-grain review **cost** (`block_artifacts` `role:'reviewed'` → cost-per-review) — follow-up.
- Layer 1 (explicit `gh pr review` posting → `pr_reviewed`/`pr_approved`) — follow-up.
- Layer 2 is **LLM-dependent** (no `use_case` without enrichment) — accepted.
- The read path already returns `sa.role`/`sa.source` per session artifact, so a
  `reviewed` role surfaces in session detail with no client change.
