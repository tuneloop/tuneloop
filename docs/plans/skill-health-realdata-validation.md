# Skill Health — real-data validation report

Store: `~/.tuneloop/tuneloop.sqlite` · Dashboard: http://localhost:4800 · Evaluated at nowMs = 2026-07-27T17:00Z
Scope: task #10 — validate all Skill Health phases on real seeded data.

---

## Round 2 refinements (✅ DONE — commits 335fd95, a62bebf)
Four issues raised after reviewing the live UI:
1. **Removed the "friction-adjacent" proxy entirely.** It only meant "a tool call errored within 3 calls
   after the skill" — an unrelated error near a skill isn't friction FROM it, and the LLM reworked/bypassed
   verdict now covers "did the skill go wrong" with real evidence. Dropped the stat tile, the drift
   before/after metric, the version-timeline "% friction-adj" (now "% errored"), the "friction after"
   invocation tag, and the explanatory section. Kept `errorCalls` (own-call error rate — factual, clearly named).
2. **Verbose on-page prose → tooltips.** The co-occurrence and activation-outcomes explanations moved into a
   `?` info badge on the section header; the outcomes footer is now a terse "Judged N firings". The
   "friction-adjacent means" block and the "measured from real sessions" tail are gone.
3. **Evidence truncation fixed.** Snippets were cut mid-word ("…summary at t"). The prompt now asks for ONE
   complete <200-char sentence, and a word-boundary clip backstops an over-long reply. Processor version 2→3.
4. **Version boundaries dated by file mtime, not analyze time.** `readSkillFile` now captures the SKILL.md
   mtime as `editedAt`; drift uses it (clamped to (prev-boundary, capture]) so an edit dates to when it
   actually happened, falling back to capture time when the mtime is implausible (clone/checkout reset).
   `editedAt` is stripped from the change-detection hash, so a touch/clone that bumps mtime without changing
   content does NOT append a spurious version. GOTCHA: existing snapshot rows won't carry `editedAt` until
   each skill's content next changes (the unchanged-payload path doesn't rewrite the row) — it lands on new
   edits/fresh ingests going forward.

933 tests pass. UI verified via browser (3 tiles, no friction text, tooltips present, followed/bypassed intact).

---

## TL;DR

- **The seeding worked.** All four deterministic phases are exercised on real data, and — for the first
  time ever — **drift renders a real before/after delta** (`changelog-generator`, 2 versions, 4 calls each
  side). That was the never-validated hero panel; it's now validated end-to-end.
- **Two things to fix on your side** (small): the "unused" and "scope-down" cases aren't cleanly seeded.
- **One real code bug found:** `skillDrift` picks the wrong repo when a skill exists in multiple repos —
  it can miss (or invent) an edit. It happened to work for `changelog-generator` by luck of iteration order.
- **The Activation Outcomes panel is the weak link — your instinct is right.** It's low-signal by
  construction, and 45% of its verdicts here are `unclear` from missing context. Details + redesign options below.

---

## What you seeded (verified in the store)

| Skill | Repos used in | Calls | Versions captured | Panel it exercises |
|---|---|---|---|---|
| `changelog-generator` | telemetry-sandbox | 8 | **2** (edited once) | **Drift (hero)** ✅ |
| `git-commit-helper` | telemetry-sandbox (5) + self-improving-agents (2) | 7 | 2 in tel-sandbox, 1 in self-imp | Per-repo / broad scope ✅ |
| `test-writer` | — | 0 | 1 | (intended scope-down — see gap) |
| `unused-demo` | — | 0 | 1 | (intended unused — see gap) |

Plus a large tail of your *real* skills (browse, review, health, claude-api, grill-with-docs, codex/opencode
skills) that rode along and gave the outcome classifier a realistic corpus.

---

## Phase-by-phase results

### 1. Roster / status / flags — ✅ working, one seeding gap
- `changelog-generator`, `git-commit-helper` → **used**. Correct.
- `test-writer`, `unused-demo` → 0 calls → **unused**. Correct status, BUT see "Gaps on your side" —
  `test-writer` was *meant* to be a "used in one repo → scope-down" case, and it ended up unused instead.

### 2. Per-repo breakdown / scope-down vs broad — ✅ working
- `git-commit-helper` is genuinely used in **2 repos** (telemetry-sandbox + self-improving-agents) →
  this is the **broad-scope** case, and it's real. Good.
- No skill is cleanly the **scope-down** case (used heavily in exactly one repo while installed in several).
  `changelog-generator` is single-repo but only installed in one repo, so it's not scope-down either.

### 3. Drift & version comparison (HERO) — ✅ VALIDATED for the first time
`changelog-generator`:
```
v0  07-27 14:02 → 16:17   calls=4  enough=true
v1  07-27 16:17 → now     calls=4  enough=true
DELTA  edit=16:17  windowDays=1  before=4  after=4  enoughData=true
```
This is the payoff: the panel that could never be validated (needs an edit between analyze runs + usage on
both sides) now produces a real, honest before/after. The append-on-change snapshot logic, version
reconstruction, symmetric capped window, and MIN_DRIFT_CALLS gate all behaved correctly on real timestamps.

⚠️ `git-commit-helper` reports `singleVersion: true` (no drift) — **but it WAS edited** (bodyHash
`b3d05bb…` → `fd27ce3…` at snapshot 2 in telemetry-sandbox). It should show 2 versions. This is the code
bug below, not a seeding miss.

### 4. Co-occurrence — ✅ working (thin, as expected)
- `changelog-generator` ↔ `git-commit-helper`: 1 shared session, share 0.13/0.14. Real, correctly
  computed, correctly directional (`precededSessions` asymmetric). Only 1 co-session because you rarely
  paired them — fine; the mechanism is proven.

### 5. Activation Outcomes (LLM) — ⚠️ runs correctly, but low signal (your concern is valid)
The classifier fired (Haiku/Bedrock), produced 25 session annotations, and the double-count fix held
(no phantom `skill-N` firings). Distribution:

| Skill | classified | used | reworked | ignored | unclear |
|---|---|---|---|---|---|
| changelog-generator | 8 | 3 | 1 | 0 | **4** |
| git-commit-helper | 7 | 3 | 3 | 0 | 1 |
| browse | 4 | 3 | 0 | 0 | 1 |
| review | 2 | 0 | 2 | 0 | 0 |
| improve-codebase-architecture | 2 | 0 | 0 | 0 | 2 |
| health | 1 | 1 | 0 | 0 | 0 |

**Problems (matches your gut):**
1. **45% of `unclear` verdicts (9 of 11) are "no surrounding context / transcript ends" —** i.e. the model
   had nothing to judge, not a genuinely ambiguous outcome. `unclear` is doubling as "I couldn't see enough."
2. **`used` is near-vacuous.** Almost every evidence string is *"the agent invoked X and then proceeded to
   call Bash / act on the output"* — that's just "the agent kept working," which is true of virtually every
   skill firing. It restates the transcript; it doesn't tell you whether the skill *helped*.
3. **The one genuinely interesting signal is buried:** `reworked` (agent invoked the skill then manually
   redid the work — e.g. git-commit-helper 3/7 reworked: "invoked the skill, then manually staged and
   committed instead of using its output"). *That's* the insight — the skill fired but the agent didn't
   trust/use its output. It's drowned by bland `used`/`unclear`.

---

## Gaps on YOUR side (quick fixes, optional)

1. **`unused-demo` and `test-writer` both ended up "unused."** You wanted `test-writer` to be the
   scope-down case. To seed it cleanly: run **≥1 real session in telemetry-sandbox that invokes
   `test-writer`**, and leave `unused-demo` untouched. Then re-analyze.
2. **No clean scope-down case.** For the sharpest validation, pick one skill that's **installed in both
   sandbox repos but used in only one** (e.g. install `test-writer` in self-improving-agents too, but only
   invoke it in telemetry-sandbox). That's what lights up the amber "scope-down" flag.
3. **`git-commit-helper` in self-improving-agents has only 1 snapshot** (b3d05bb… — the *old* body). If you
   want its drift to work there too, edit it in that repo and re-run a session + analyze. (Not required —
   telemetry-sandbox already has its 2 versions.)

None of these block the validation; they'd just make the roster flags fully exercised.

---

## Code bug found — `skillDrift` reads the wrong repo (✅ FIXED, per-(skill, repo))

> **Status: fixed on `feat/skill-health-prototype`.** `resolveDriftScope` now picks one install
> location (the busiest project repo, else global) and scopes BOTH the version timeline and usage to it;
> `SkillDriftReport.repo` names it; the client labels the panel with the repo. Real-store proof:
> `git-commit-helper` went `singleVersion:true` → **2 versions** (edit at 15:33 detected, telemetry-sandbox
> picked over self-improving-agents); `changelog-generator` unchanged (no regression). 924 tests pass,
> incl. a new same-name-two-repos discriminating test. Details below.


### The bug
`src/server/skill-health.ts:870 skillSnapshotHistory` picks the **first project scope_key** whose history
mentions the skill, ordered by an **unordered `SELECT DISTINCT scope_key`** (SQLite returns B-tree order,
effectively arbitrary). It reconstructs versions from *only that one repo's* timeline, while **usage is
aggregated across ALL repos** (`usageInWindow` has no repo filter). That split — versions from one arbitrary
repo, usage from all — is the root defect.

Confirmed consequences on this store:
- **`git-commit-helper` shows `singleVersion: true` (no drift) even though it WAS edited** in
  telemetry-sandbox (b3d05bb… → fd27ce3…). The picked repo was `self-improving-agents` (old body only, 1
  snapshot), so the edit is invisible; its 7 real invocations get no before/after.
- **`changelog-generator` worked only by luck** — it lives in exactly one repo, so there's no wrong repo to pick.
- A skill edited in repo A but not B shows drift or not **depending purely on iteration order** —
  non-deterministic across stores.

### Decision (user): per-(skill, repo) drift — NOT a merged timeline
Merging all scopes into one timeline was rejected, correctly: **two repos can hold genuinely different
skills that share a name** (`.agents/skills` is not always the same body). A merged timeline would collapse
or interleave two unrelated bodies and **fabricate phantom edits**. Per-(skill, repo) is the only honest model.

**Clean-rework shape (no patch-up):**
- `skillDrift(store, name, repo, nowMs)` — repo becomes part of the identity. `skillSnapshotHistory` reads
  the ONE scope's history: the project scope_key whose repo basename matches `repo` (global for a
  global-only skill). No cross-repo union, no arbitrary pick.
- **Scope usage to the same repo too** — `usageInWindow` gains a repo filter so versions AND usage come from
  the same repo. This finally makes the drift panel internally consistent (today's numbers mix repos).
- Detail page picks the repo to show = the repo where the skill has the most invocations (deterministic;
  falls back to global). The `perRepo[]` breakdown already computed for Phase 1 gives us that ranking for free.
- API `/api/skill-drift` gains `&repo=`; client `loadDrift(name, repo)` passes it.
- Update `skill-drift.test.ts` + the synthetic generator (both currently use global-scope snapshots) and add
  a discriminating test: same name, two repos, edited in ONE → drift shows for that repo only, the other
  stays single-version. This is exactly the case that's broken today.

---

## Activation Outcomes — LLM-side rework (✅ DONE, validated on real data)

> **Status: processor reworked on `feat/skill-health-prototype` (skill-outcomes version 1→2, re-runs the
> classifier).** Window now extends from a little leading context to the NEXT real user turn / next skill
> firing (cap 30 events), rendering Esc-interrupts and tool errors inline as friction; taxonomy gained
> `insufficient-context` (distinct from genuine `unclear`); prompt reframed to followed-vs-bypassed. No
> `theme_events` dependency (phase-order blocked + redundant — the raw friction is in-session).
>
> **Real re-run (Haiku, 25 sessions with firings):** `unclear` **11 → 0**; `insufficient-context` = 2
> (both are firings that literally end the session — honest, not noise); `reworked` = 9 with specific,
> grounded evidence (e.g. review→"checking a diff from the wrong repo, abandoned the output and pulled the
> PR manually"; huggingface-llm-trainer→"skill's recipe used outdated TRL max_seq_length, adapted to
> max_length"; health→"tool error, user interrupted and redirected"). The evidence is now insight, not a
> restatement of the transcript. 9 processor tests pass (added: insufficient-context round-trip, window
> extends-to-next-turn + interrupt-visible). NEXT: read+UI-side (below).

### Read + UI-side (✅ DONE)

> **Read model + client reworked on `feat/skill-health-prototype`.** `SkillOutcomeStats` now derives
> `bypassed` (reworked+ignored) and counts `insufficientContext` SEPARATELY — insufficient-context verdicts
> are excluded from the distribution entirely (per decision: hidden), and a skill with only those returns
> null (panel hidden). Evidence examples order bypass cases first. Client leads with a "pulls its weight"
> callout (Mostly followed / Sometimes reworked / Often bypassed, colour-coded by bypass rate) then the
> followed/bypassed bar; labels reframed Used→Followed, Ignored→Bypassed. Verified on real data via browser:
> changelog-generator → "Sometimes reworked, 2 of 8 (25%)" with reworked evidence leading;
> improve-codebase-architecture (only insufficient-context) → panel correctly hidden. 928 tests pass (added
> read-model tests for the insufficient-context exclusion + bypassed derivation).

Panel today answers *"did the agent keep going after the skill fired?"* — almost always yes → low signal.

### Q2 re-diagnosed: "missing context" is MOSTLY OUR BUG, not absent context
The user asked to find out *why* context is missing before dropping `unclear`. Investigated — the premise is
mostly false. For each `unclear` firing, `calls_after` = tool calls remaining in the session after it:

```
changelog-generator idx=0    calls_after=4
git-commit-helper   idx=1    calls_after=3
openai-docs         idx=12   calls_after=51
improve-codebase-…  idx=2    calls_after=112
claude-api          idx=16   calls_after=114
browse              idx=1619 calls_after=1155
```

9 of 11 `unclear` verdicts say *"no surrounding context available"* — **but the context was right there**
(50–1155 calls followed). The context isn't absent from the session; it's absent from **what we send the
model**: the window is hardcoded `CONTEXT_BEFORE=2` / `CONTEXT_AFTER=4` events (`skill-outcomes.ts:38`). A
skill whose payoff lands >4 events later falls outside the window → Haiku honestly says "can't tell."

**So: do NOT silently drop `unclear`** (that hides our own defect and could drop real signal). Instead:
1. **Widen / smarten the context window** so most of these resolve. Options: raise CONTEXT_AFTER; or make it
   token-budget-based rather than event-count; or extend the window to the next user turn / next skill firing.
2. **Split the label**: `unclear` (genuinely ambiguous — the ~2 real cases) vs `insufficient-context` (our
   window was too small). Only truly-tail firings (`calls_after=0`) legitimately fall in the latter.

### Friction-adjacency: replace the error-proxy with REAL friction (user idea — adopted)
Today `frictionAdjacent` is a crude SQL proxy — "an *errored tool call* within 3 calls after the firing"
(`skill-health.ts:34,261`). It has **nothing to do with the recurring-themes detector** and misses silent
rework (agent redoes the work with no error). The recurring-themes detector persists real friction in
`theme_events(session_id, turn_seq, trigger, description)` — actual user corrections / rework moments.
Since skill firings carry a `seq`, we can join: **"was a real friction event within N turns after this
skill fired?"** and **pass that event's description + index into the LLM context window** so it judges the
firing against the actual friction, not a blind ±few turns. Strictly better `reworked`/`userCorrectionAdjacent`.

### A + C (adopted)
- **(A)** Reframe to **"followed vs. bypassed."** Lead with `reworked`/`ignored` (the friction — e.g.
  git-commit-helper 3/7 reworked: "invoked, then committed manually anyway"); demote bland `used`; split
  `unclear`→`insufficient-context`.
- **(C)** One honest per-skill line combining outcome + REAL-friction-adjacency + rework-rate, instead of a
  stacked bar that's mostly `used`. Fewer, load-bearing claims (correctness-over-coverage).

---

## Q4 — per-category vs per-skill snapshots: KEEP per-category (do not split)
Honest verdict: the "edit one skill → all bump" fear is **not real at the layer that matters**. Drift reads
each skill's OWN body-hash from inside the payload (`bodyHashOf`) and versions only when THAT skill's hash
changes. Proven on this store: `git-commit-helper` changed at snapshot 2, `changelog-generator` at snapshot
3 — drift gave `changelog` exactly 2 versions, NOT 3. Neighbors don't cross-contaminate.
The only real cost of per-category is storage write-amplification (editing one skill rewrites the category
row) — kilobytes at this scale, negligible. A per-skill table = a migration across all 4 adapters'
`readEnvironment` + `recordEnvSnapshot` + every consumer, for a storage micro-opt. That's the
over-engineering direction. Recommendation: keep it; add a comment noting per-skill versioning is a
read-time concern handled by `bodyHashOf`.

## Q5 — per-source skill snapshots (codex/opencode/pi duplicate `.agents/skills`): DOCUMENT, don't migrate now
Confirmed duplication: codex + opencode stored byte-identical skill payloads for telemetry-sandbox (same
hash `af670…`) because both read the shared `.agents/skills`. Honest assessment:
- Not *incorrect* — each source faithfully records "what that agent sees"; it's redundant, not wrong.
- **Doesn't hurt skill-health** — the feature is entirely claude-code-scoped (`SOURCE='claude-code'`, filters
  both usage and snapshots to it), so codex/opencode/pi skill snapshots are never read here (they still
  serve each adapter's own capability analysis).
- The deeper point is right: skills are becoming an agent-agnostic, repo-level resource, so per-source
  attribution is conceptually off. But `environment_snapshots` is keyed by `source` schema-wide — a
  source-agnostic skill inventory is a schema revamp worth doing only when skill-health goes multi-agent.
  Today it's single-agent → flag as a documented future concern, don't churn now.

---

## Bottom line
- Task #10 **substantially validated**: roster, per-repo/broad-scope, **drift (hero)**, and co-occurrence
  all confirmed correct on real data. (Scope-down already covered by git-commit-helper broad case;
  test-writer global-install skipped per user.)
- **Fix now (clean rework):** per-(skill, repo) drift — versions AND usage scoped to one repo; deterministic
  repo pick; API+client+tests+generator updated; discriminating same-name-two-repo test added.
- **Rework (design agreed):** Activation Outcomes → followed/bypassed framing (A), per-skill weight line (C),
  wider context window + `unclear`/`insufficient-context` split (Q2), real-friction-adjacency from
  theme_events fed into the LLM (friction).
- **Keep as-is + document:** per-category snapshots (Q4), per-source skill duplication (Q5).
