# Session ↔ PR linkage by code-content matching

Status: **shipped** — `src/processors/pr-content-match.ts` (registered in
`processors/index.ts`). This document is the design of record.

## Problem

tuneloop links a session to a PR only when the session left an explicit transcript signal —
`gh pr create`, `gh pr merge`, or a pasted PR URL (handled by `outcomes-git.ts` /
`github-pr.ts`). The common workflow leaves no such signal: the user asks the agent to
implement something, then commits and pushes it themselves, outside the session. The
transcript never sees a `gh`/`git` push, so the session is never linked to the shipped PR,
and its per-session cost and metrics are lost for exactly the work that shipped.

The linkage is recovered from **content alone**: the code the agent authored (already in
the ingested transcript) is matched against the code a PR added, with no stored connection
between the two sides.

## What is matched

- **Session side:** the agent's authored lines — the union of everything the agent emitted
  in the session (a superset that includes intermediate states later overwritten, which
  only helps recall). Extracted per harness from the file-write tool calls:
  - Claude `Edit`/`Write` (`new_string`/`content`) and `MultiEdit` (`edits[].new_string`).
  - Codex `apply_patch` (raw `*** Begin Patch` string, `+` lines).
  - OpenCode `write` (`{filePath, content}`), `edit` (`{filePath, newString}`), and
    `apply_patch` (`{patchText}`, same `*** Begin Patch` format as Codex — enabled only for
    gpt-5-class models, where it replaces `edit`/`write`).
- **PR side:** the net merged diff's added (`+`) lines (`gh pr diff`), which collapses the
  PR's intermediate commits into what actually shipped. Only shipped content is attributed;
  agent work overwritten before merge correctly earns no credit.
- **Anchor:** containment of the PR's added lines within the session's authored lines —
  *a PR change links to the agent if the agent authored it.* The score is the fraction of
  the PR's added lines attributable to the session, so several sessions can each own a slice
  of one PR independently.

### Matching hierarchy

```
repo (hard scope — cross-repo never matches)
  └─ repo-relative path (exact file key; absolute session paths normalized to this;
     full path not basename, so a repo's two different index.ts don't cross-match)
       └─ line containment (PR-added ⊆ session-authored, that file)
```

Per-`(session, PR)` confidence = matched PR-added lines ÷ total PR-added lines, over files
present on both sides. Lines are whitespace-normalized (runs collapsed, ends stripped, case
kept) and blank / whitespace-only / pure-bracket lines are dropped before comparison.

### Many-to-many

One session commonly feeds many PRs; one PR occasionally draws from many sessions. The
output is a weighted bipartite graph of `(session, PR, confidence)` edges, not a 1:1
assignment. PR-anchored containment makes each session's share of a PR independent of the
others'.

### Out of scope

Renames / moves / relocations done without an agent tool call (rare, low-signal). A pure
rename already contributes nothing (git rename detection ⇒ zero `+` lines); content moved
to a new path manually is an accepted miss.

## Algorithm choice: line-level containment

A prototype bake-off compared three representations on real corpora and on a synthetic
divergence test: **A** single normalized line (k=1), **B** k=3 line shingles, **C**
IDF-weighted shingles.

- On the verbatim real corpus all three tied at precision = recall = 1.0 once
  author-scoped.
- Under synthetic divergence (a human keeps/reflows/renames part of the agent's output),
  line-level (A) was strictly more robust — decisively so on **partial-keep**, the most
  common real human edit, where A held 1.00 while shingles collapsed to ~0.06 (any dropped
  line shatters a 3-line shingle). IDF (C) was consistently no better than B.

Line-level containment was chosen: most robust where divergence actually happens, and the
simplest to reason about. Its one weakness — slightly promiscuous single-line matches — is
handled by author-scoping plus a matched-line floor rather than by a heavier representation.

## Precision controls

**Author-scoping is load-bearing, not just a cost cut.** Content similarity alone cannot
separate a small real contribution from coincidental shared-code overlap: in the eval a true
edge scored 0.075, below a false edge (a teammate's PR) at 0.18. Authorship separates them
cleanly — the true low-confidence edges were all the user's own PRs, the false ones all
teammates'. Candidate PRs are therefore scoped to the user's own via `gh pr list --author
@me`, which is what makes a low threshold safe (false positives at t=0.05 dropped 5 → 0
under scoping). This is the superset of "created by this session": PRs the user authored or
committed to.

**Two gates guard each link, and they differ:**

- The **`MIN_MATCHED` evidence floor** (≥3 matched lines) applies to *every* PR, created or
  inferred. A ratio computed from one or two lines is noise regardless of certainty, so a PR
  with under three matched lines gets no content-match link. (For a PR the session created,
  its `pr_created`/`pr_merged` link from `outcomes-git` still stands; only the
  content-derived attribution % is withheld.)
- The **`CONF_THRESHOLD` fraction gate** (≥0.10) is a precision cut for *inferred* links
  only. A created PR that clears the evidence floor keeps its attribution even at a low
  fraction, since its contribution is already certain.

A **merge-time guard** drops any candidate PR that merged strictly before the session
started — the session provably cannot have authored code that shipped before it ran. It
excludes only on a valid, strictly-earlier merge time; open/unmerged PRs and unknown times
are kept, so it never over-excludes.

## What it writes

The processor is `static` + `needs.network`, requires `segment-blocks`, and fetches
candidate PRs once per repo per process (memoized; a transient `gh` failure is not cached).
The candidate set is the author's 200 most-recent PRs in the repo, any state
(`gh pr list --author @me --state all --limit 200`); the per-session merge-time guard then
trims those that shipped before the session ran.

- `artifacts` (kind `pr`): the PR, with `json.addedLines` = total PR-added lines, which
  makes `matched` (and per-PR attribution summed across sessions) recoverable from
  `confidence`.
- `session_artifacts`: the attribution link — `role:'edited'`, `source:'derived'` (so it is
  user-rejectable, like other inferred links), `confidence` = the AI-attribution fraction.
  Recorded for **every** contributed PR, including ones the session created itself, because
  the attribution % is wanted for the agent's own PRs too.
- `block_artifacts` + a `pr_contributed` outcome: emitted **only for inferred** links. For
  PRs the session explicitly created/merged, `outcomes-git` already owns cost attribution at
  block grain and the `pr_created`/`pr_merged` outcomes, so those rows are not re-emitted.
  Block links carry NULL confidence (per-block fraction is not quantified; the session→PR
  attribution % lives on the session link). Coexisting links to one PR never double-count
  because the store's cost queries `UNION` over usage-fact rows.

`refresh()` keeps discovered PRs' merge status current via `gh pr view` (these PRs may exist
only because of a content match, so no other processor refreshes them), mirroring
`outcomes-git.refresh`.

## Evaluation

The bake-off ran on real corpora from three repositories actively driven with Claude and
Codex: 11 sessions · 71 PRs · a truth set of 16 auto-labels (sessions that left a transcript
create/merge signal, held out and stripped from the matcher's input) + 3 hand-labeled
human-pushed edges. Only 20 of the 71 PRs were the developer's own; the other 51 (teammates')
served as true negatives.

Scoped to the developer's own PRs the matcher was perfect — precision 1.00 and recall 1.00 at
t=0.05, precision 1.00 through t=0.30. On the full unscoped corpus best F1 was ~0.94–0.97,
with every low-threshold false positive a teammate's PR sharing foundational code — the
class author-scoping removes.
