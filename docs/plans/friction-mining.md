# Friction Mining & Emergent Topics (the "Improve" step)

Status: IMPLEMENTED (2026-07-04) — all phases built and e2e-verified.
Code map: `src/core/turns.ts` (shared turn helpers) · `src/processors/steering.ts` ·
`src/processors/enrich-friction.ts` · `src/reducers/friction-merge.ts` (invoked from analyze) ·
`src/store/{db,store,types}.ts` (friction_events/friction_topics + reads) · `src/server/http.ts`
(/api/friction*) · `src/server/client/friction.ts` (Friction tab).

## Goal

Mine each session's follow-up user messages for moments where the human had to **nudge, re-steer,
re-supply context, or force rework** of the agent; aggregate them across sessions into named, counted
**friction topics**, each with a remedy class (add-doc / add-skill / add-tool); cross topics against
the outcome + cost graph (correlational only). Example:

```
Context-supply → "point the agent at the default sqlite db before data analysis"  · 12 sessions
Tool-gap       → "agent can't reach the staging DB; user pastes query results"     ·  8 sessions → add MCP
```

## Decision records

- **DR-1:** Friction is extracted at the user-turn grain; every event persists `turn_seq` as an
  evidence pointer so the topic view can show the user's actual words (recovered from session blobs
  at read time).
- **DR-2:** Emergent topics, plus a coarse fixed `type` per event so the dashboard has a stable facet.
- **DR-3:** Topic assignment happens AT EXTRACTION — the prompt shows the existing topic list (the
  proven feature-hierarchy pattern); no embeddings/clustering (`LlmClient` has only
  `completeStructured`). The only cross-session step is a small merge pass. Fallback of record:
  revisit embeddings only if the corpus outgrows prompt-listable topics.
- **DR-4:** Topic ids `friction:derived:<repo-slug|global>:<label-slug>` are permanent (INSERT OR
  IGNORE, never renamed — a rename retroactively mislabels members). Repo-scoped by default;
  `preference` topics are global; *amendment:* repo-less sessions also mint global topics of any type
  (accepted trade-off — the alternative is a scope no other session can match against).
- **DR-5:** The `type` set is frozen: `re-steer, context-supply, tool-gap, rework, preference, other`.
- **DR-6:** All friction↔outcome comparisons are correlational and presented as such — high-friction
  sessions are also the long, complex ones (empirically confirmed: every merged PR came from a
  steered session).

## What was built

**`steering` (static, no LLM):** `followup_count` (user turns after the opener, bare approvals
excluded — helpers shared with enrich-session via `src/core/turns.ts`) + `steering` yes/no; facet
`steering`, measure `steering_intensity`. Deliberately NOT named "friction": the count is a ceiling —
only the LLM layer can separate genuine steering from workflow progression.

**`enrich-friction` (LLM enrichment, runs only on steered sessions):** one structured call per
session. Prompt input: numbered follow-ups, each tagged with the tool errors (`error_category`) that
preceded it positionally; assistant-limitation snippets; the existing topic list (repo + globals,
read fresh per session via `ProcessorContext.existingTopics` so assignments compound). Output events
`{turn, type, description, matched_topic_id | new_topic_label, remedy_hint, trigger}`. Postprocess:
bogus matched ids dropped; junk labels gated (event survives topicless); matched topics re-emitted
(heals a mid-run orphan prune without breaking the event FK); empty LLM payload throws (a failure,
not a zero-friction result — prior events survive, retry stays open). Deferred: feeding linked PR
review comments into the prompt — `after_review` fires only when the follow-up text itself relays
review feedback.

**Storage:** fact tables `friction_events(session_id, idx, turn_seq, block_idx, type, trigger_kind,
remedy_hint, description, topic_id)` + `friction_topics(id, label, type, remedy, repo, source,
first_seen)`; no stored rollups. Every persist prunes derived topics left with no member events.

**Merge pass (`friction-merge.ts`):** per-repo-group LLM proposals (duplicates only; empty list is the
common answer), hash-gated on the sorted topic-id set — a failed call leaves the gate unstamped so
the pass retries next analyze. Legality: same repo, or a global keeper absorbs a repo-scoped
duplicate (never the reverse); user-authored topics are never absorbed. Keeper = better-named,
preferring the older topic when both names are adequate.

**Dashboard:** Friction tab via `/api/friction` (+ `/api/friction/topic` drill-down). Topics ranked
by occurrences with outcome/cost columns vs the friction-analyzed baseline (DR-6 caption: associations,
not causes). The repo slice constrains topic visibility, event counts, and drill-down events alike.

## Spike learnings (Phase 0.5, 16 real sessions, 3 runs, <$1)

- The mechanic works: topics recur and match across sessions; quiet sessions come back empty.
- **Precision >> recall; model-bound.** Haiku leaks collaboration-as-friction and force-fits topics;
  Sonnet-class holds the boundary. Default extraction to Sonnet.
- Prompt rules that matter: explicit example-laden collaboration exclusion; concrete Title-Case
  ≤6-word labels; when unsure whether an event matches, mint (merge pass cleans up); align tool
  errors positionally; never hint an expected event count (anchoring invents events).

## Deferred

- PR-review-comment feed into the extraction prompt (see `after_review` note above).
- Topic tombstones / user edit actions (features' `rejectedFeatureTitles` pattern) — until the
  dashboard grows topic-edit UI.
- Auto-drafting the skill/doc/MCP a topic suggests — the obvious v2 ("draft this skill" button).
- Per-event facet grain (v1 uses session rollup `friction_type` / `friction_count`).
- Validating the assistant-limitation regex against all adapters before freezing it; possible
  `capability-discovery` type (currently folded into `context-supply`).
