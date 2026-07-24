# Unused-Capabilities Detector — Multi-Harness Support

## Goal

The unused-capabilities detector (`src/detectors/unused-capabilities.ts`) flags MCP
servers and skills that are installed in a harness's config but never invoked — dead
weight that loads into every session's startup. It works **only on Claude Code** today
(`SOURCE = 'claude-code'` is hardcoded). Now that all four supported harnesses capture
environment snapshots (Claude Code, Codex, OpenCode, Pi), extend the detector to every
harness — where the data supports it — and enumerate the product decisions that gate it.

## How it works today (one harness)

Two sides, reconciled:

- **Installed** (what's wired into config): read from environment snapshots via
  `parseInstalledMcp` (payload `{ "<file>": { servers: { "<name>": … } } }`) and
  `parseInstalledSkills` (payload `{ skills: [{ name, … }], count }`), for the `mcp` and
  `skills` categories, at global scope (`_global`) and each project `scope_key`.
- **Invoked** (what actually ran): read from the `capability_usage` /
  `capability_invocation` views (`src/store/db.ts`), which derive `(kind, name)` from
  tool-call rows — MCP server = the segment between the 1st and 2nd `__` in
  `mcp__<server>__<tool>`; skill = the tool-call `name`.

`classify()` produces per-capability verdicts: **remove** (never used anywhere, gated by
`MIN_SESSIONS` + `MIN_REMOVAL_TENURE_DAYS`), **scope** (global but used in ≤ half your
repos → move it into those repos), or keep. `buildCards()` folds all verdicts into one
cross-repo insight (`repo: '*'`) with a fix-prompt.

## Key finding: the invoked side is already harness-agnostic

The capability views are **already source-partitioned**. `capability_invocation` selects
`s.source` and `capability_usage` groups by it; `queryInvoked(store, since, source)`
already takes a `source` argument. The `mcp__<server>__<tool>` grammar is applied
uniformly across all sources, and **each adapter's `actions.ts` is responsible for
normalizing its own tool calls into that grammar** (Codex explicitly rebuilds
`mcp__<server>__<tool>` from its namespaced function calls; see `codex/actions.ts:31`).

The **installed** payload shapes are also identical across harnesses — every adapter's
`readMcp` emits `{ "<file>": { servers } }` and every `readSkills` emits
`{ skills: [...], count }`. So `parseInstalledMcp` / `parseInstalledSkills` already parse
Codex / OpenCode / Pi snapshots unchanged.

**Consequence:** making the detector source-parametric is a small change (drop the
hardcoded `SOURCE`, run per source). The genuine work is in the **per-harness invocation
detection gaps** below — where a harness fails to tag its invocations, an installed
capability looks "never used" and we'd wrongly recommend removing something in active use.

## Per-harness readiness matrix

| Harness | Installed captured | MCP invocation | Skill invocation | Ready to enable |
|---|---|---|---|---|
| **Claude Code** | mcp, skills, agents | ✅ `mcp__srv__tool` | ⚠️ implicit ✅ (`Skill` tool) · explicit `/name` ❌ (command envelope, verified) | mcp: yes · skills: implicit only |
| **Codex** | mcp, skills, agents | ✅ normalized to `mcp__srv__tool` | ⚠️ shell-read heuristic MISSES the `$name` envelope path (verified) | mcp: yes · skills: needs envelope parsing |
| **OpenCode** | mcp, skills (+commands), agents | ❌ `action='other'` (verified `atlassian_getJiraIssue`) | ✅ `skill` tool — implicit AND explicit `/skills` both route through it (verified) | skills: yes (both paths) · mcp: allowlist reconcile (verified) |
| **Pi** | skills (no mcp/agents) | n/a (Pi ships none) | ❌ today, but ✅ achievable — `read` of `SKILL.md` (see below) | small change, then ready |

### The gaps, precisely

- **Claude Code skills — the EXPLICIT path bypasses the tool (verified).** CC has two
  invocation paths and we only catch one. *Implicit* (user asks in natural language, the
  model calls the `Skill` tool) is recorded as a `Skill` tool_use → `action='skill'` →
  detected (confirmed, `/review` transcript). *Explicit* (`/skill-name`) is NOT: verified
  transcript (`93149637`, `/hello-world`) records it as a **`<command-name>/hello-world
  </command-name>` user message** plus an **`isMeta: true` user message** injecting the
  SKILL.md body prefixed `Base directory for this skill: …/.claude/skills/hello-world`, and
  the model then acts directly — **zero `Skill` tool_use in the session** (only `Bash`). So
  the explicit path is invisible to `action='skill'` detection, same false-negative class as
  Pi/Codex. **Signal to add:** a `<command-name>/X</command-name>` whose `X` (sans slash)
  matches an installed skill, corroborated by the `isMeta` "Base directory for this skill:
  …/skills/<name>" marker (a clean, skill-specific tell that distinguishes it from ordinary
  slash commands like `/model`). *This overturns an earlier draft claim that CC had no
  envelope-bypass gap — it does.*

- **OpenCode MCP is invisible — fix verified.** `opencode/actions.ts` can't distinguish
  MCP tools (`<server>_<tool>`) from built-ins by name, so they map to `action='other'` and
  never reach the capability views. Verified transcript (`opencode.db`, Atlassian call):
  the tool part is recorded as **`tool='atlassian_getJiraIssue'`** (`<server>_<tool>`, single
  underscore) → `action='other'` → invisible → an installed `atlassian` server always looks
  unused → false removal. *Fix (verified sound):* reconcile `action='other'` tool names
  against the **installed server names from the snapshot** — treat `<prefix>_<rest>` as a use
  of server `<prefix>` only when `<prefix>` exactly matches an installed server. This
  dissolves the ambiguity the code comment worried about: `apply_patch` is a *built-in* with
  an underscore, but it matches no server named `apply`, so it's never misclassified. The
  action mapper is name-only (no config access), so this reconciliation belongs in the
  **detector layer**, not `mapAction` — OpenCode MCP calls can't be rewritten to the uniform
  `mcp__server__tool` grammar at parse time because the parser doesn't know the server set.

- **Pi skills are invisible — but the signal IS in the transcript.** `pi/actions.ts`
  maps `read` → `action='file_read'` and has no `skill` branch, so skill invocations are
  currently lost. *Resolved by transcript inspection* (`newCo-X`, "run the hello test
  skill"): Pi engages a skill by **`read`-ing its `SKILL.md`** — a real `read` tool call
  with `{"path": ".../.pi/skills/hello-test/SKILL.md"}`, then `bash` runs the skill's
  scripts. This is the same engagement model as Codex, but *cleaner*: the path is a
  structured tool argument, not a shell string to regex. **Fix (small, Codex-analogous):**
  in `pi/actions.ts`, reclassify a `read` whose path matches a skills `SKILL.md` to
  `action='skill'`, name = the parent directory of `SKILL.md`. Two path shapes to cover:
  `<…>/skills/<name>/SKILL.md` (dir skill) and a direct-child `<…>/.pi/skills/<name>.md`
  (Pi's root-`.md` individual-skill form). Reconciliation nuances:
  - **Name identity.** The invoked name derived from the path is the *directory* basename;
    the installed name is the *frontmatter* `name` (Pi lets them differ). They match in the
    common case, but a skill that renames itself in frontmatter would need reconciliation on
    the dir basename to avoid a false "unused".
  - **`/skill:name` forced-load — CONFIRMED to bypass tool calls.** Second transcript
    (`newCo-X`, `2026-07-24T19-51`): invoking via `/skill:hello-test` emits **no `read`
    tool call**. Pi injects the skill body as a **synthetic `user` message** wrapped in
    `<skill name="hello-test" location="…/SKILL.md">…</skill>`, then runs the script. So
    the `read`-reclassification alone misses every `/skill:name` invocation — the *strongest*
    (explicit, deterministic) use signal. The envelope is highly structured and carries the
    **authoritative `name` attribute** (no path-vs-frontmatter reconciliation needed) plus
    `location`. **Pi therefore needs TWO detection signals:** (a) reclassify a `read` of a
    `SKILL.md` path → `action='skill'` (model-initiated), and (b) parse the `<skill name=…>`
    user envelope → skill invocation (`/skill:name`).

    **Architectural implication:** signal (b) produces **no tool call**, yet the entire
    `capability_usage`/`capability_invocation` machinery reads from `tool_calls`. The Pi
    parser must *synthesize* a skill-invocation row (`action='skill'`, name = the envelope's
    `name`) when it sees a `<skill …>` user message — a message-level signal, not a
    tool-level one. This holds for **three of the four** harnesses (verified): the explicit
    skill path is a **message-level signal, not a tool call** — Claude Code `/skill-name`
    (`<command-name>` envelope + `isMeta` SKILL.md injection), Codex `$skill-name`
    (`<skill><name>…</name><path>…</path>…>`), and Pi `/skill:name`
    (`<skill name=… location=…>`) all bypass the tool layer. **OpenCode is the exception:**
    its explicit `/skills <name>` command routes THROUGH the `skill` tool — verified
    transcript (`ses_06a37008…`, `/skills hello-world`) shows a real `skill` tool part
    (`input.name="hello-world"`) → `action='skill'`, already captured. So the
    `tool_calls`-based view model sees OpenCode's explicit path but is blind to CC/Codex/Pi's.
    The design should treat "invocation source" as pluggable — tool calls AND message
    envelopes — rather than assuming everything is a `tool_calls` row. Note too that the
    CC/Codex/Pi envelopes are synthetic user turns — parsers/detectors that count "real user
    prompts" must exclude them or risk inflating turn counts.

- **Codex skills — the heuristic misses the primary path (verified).** `codex/actions.ts:48`
  infers a skill only from a shell command reading `…/.X/skills/<name>/SKILL.md`. But the
  explicit `$skill-name` invocation does NOT read the file via shell — verified transcript
  (`aivue`, `2026-07-24T12-52`, "use $hello-world"): Codex injects the skill as a **synthetic
  `user` message** `<skill><name>hello-world</name><path>…/SKILL.md</path>---…</skill>`, and
  the model answers directly with **no shell call at all**. The heuristic sees zero
  invocations → the skill is flagged unused → *false removal*. Codex skills therefore need
  the **same envelope parsing as Pi** (below); the shell-read heuristic is at best a
  secondary signal for the model-initiated path and can't be trusted for a removal verdict
  on its own.

### Payload nuances that bite

- **Commands / prompts masquerade as skills.** OpenCode's `skills` category folds in
  *commands* (`kind: 'command'`), and Pi settings carry `prompts`. These are
  user-invoked slash-commands, not tool-call-invoked — their use never appears as a tool
  call, so they'd *always* read as unused. The installed set must filter to
  `kind === 'skill'` (or handle commands under a separate, invocation-aware model).
- **Agents are captured but unhandled.** Codex / OpenCode / Claude Code all snapshot an
  `agents` category. Sub-agents also inflate startup (their descriptions load into the
  system prompt), but we don't currently detect *which* agent a `task_spawn` invoked, so
  they can't be reconciled yet → out of scope until agent-invocation detection exists.
- **MCP server-name identity.** Verify Codex's rebuilt namespace (`mcp__<server>`) uses
  the same `<server>` string as the config key, or the exact-match reconciliation drops
  real usage.

## Implementation status

**Skills-usage capture (DONE — this branch).** The parser-level gap is closed; every
harness now records skill invocations that reach `capability_invocation`. Verified against
real transcripts and covered by red→green parser tests.

- New shared builder `src/adapters/skill-invocation.ts` — `synthSkillCall(name, …)` mints
  a `ToolCall{action:'skill'}` for message-envelope invocations (fields the views need;
  block attribution falls back to nearest-by-ts).
- **Claude Code** (`actions.ts` + `parse.ts`, PARSE_VERSION 9→10): `explicitSkillName()`
  reads the `isMeta` "Base directory for this skill: `<dir>`" body → synthesized skill call
  (name = dir basename). Implicit path already worked (`Skill` tool).
- **Codex** (`actions.ts` + `parse.ts`, 7→8): `explicitSkillName()` reads the injected
  `<skill><name>…</name></skill>` envelope → synthesized skill call. (Shell-read heuristic
  retained for the model-initiated path.)
- **Pi** (`actions.ts` + `parse.ts`, 1→2): implicit — `read` of a `…/skills/…/SKILL.md`
  reclassified to `action='skill'` (`skillFromReadPath`); explicit — `<skill name="…">`
  envelope → synthesized skill call, and the injected turn is flagged `isMeta` so it
  doesn't inflate human-prompt counts. Added `name?` to Pi's `MappedAction`; the three
  tool-call sites now use `mapped.name ?? pending.name`.
- **OpenCode** — no change needed; both skill paths already route through the `skill` tool.

**OpenCode MCP reconcile (DONE — detector layer).** OpenCode records MCP as bare
`<server>_<tool>` with no marker, so the parser can't tag it (`action='other'`, invisible
to the view). The pipeline reads env AFTER parse (parse → ingest → capture env → detect),
so the reconcile lives in the detector, which runs last with both tool calls and installed
server names in the store. `queryInvokedOpencodeMcp()` matches `action='other'` opencode
calls against the installed server names (longest-server-first, `name === s || startsWith(s
+ '_')`); `loadInvoked()` folds it into the invoked set for `source='opencode'` only (no-op
elsewhere). Wired into `run()` but dormant until `SOURCE` is parametrized. Verified: unit
tests use the real tool name `atlassian_getJiraIssue`, and the real config keys the server
as `atlassian` (prefix == config key).

**Per-harness parametrization (DONE — detector layer).** The detector is no longer
CC-only: `run()` loops the sources that captured config (env snapshots UNION sources with a
surfaced insight, so an emptied config can still resolve), and `runForSource(source)` emits
**one insight per harness**, keyed `unused-caps:<source>` (repo `'*'`), with the whole
installed/invoked/classify/evidence pipeline threaded by source. Uniform keys (no CC
special-case; existing CC markers intentionally not preserved). Cards are harness-labelled
in title + fix wording (`HARNESS_LABEL`). `parseInstalledSkills` now drops `kind:'command'`
entries so OpenCode's folded-in commands aren't false-flagged. The OpenCode-MCP reconcile
above now activates for `source='opencode'`. Covered by red→green tests (multi-source
per-source insights; OpenCode command exclusion).

**Still outstanding:** confirm Codex's rebuilt `mcp__<server>` string equals the config key
(needs a live Codex-MCP transcript); the narrow Pi implicit name edge (dir-basename vs
frontmatter name). Pi prompts are a non-issue — they live in the `settings` category, never
in `skills`, so they were never in the installed-skills set.

## Implementation plan (phased)

**Phase 0 — Parametrize by source (no behavior change).** Remove the hardcoded
`SOURCE`; drive the detector per source. Two options: (a) `run()` loops over the sources
that have snapshots, or (b) register one detector instance per source. Keep Claude Code
output byte-identical (guard with the existing tests). Decide the `signalKey`/`repo`
scheme here — see Product Question 3 — because it fixes the insight-id format and any
change orphans existing CC fix-prompt markers.

**Phase 1 — Codex.** Enable MCP immediately (high-confidence detection). Gate skills
behind a validation pass on the shell-read heuristic (or ship Codex mcp-only — Product
Question 4).

**Phase 2 — OpenCode.** Enable skills immediately. Add OpenCode MCP invocation detection
(reconcile `<server>_<tool>` `other` calls against the snapshot's installed server names),
then enable OpenCode MCP.

**Phase 3 — Pi.** Investigate how Pi records skill invocations; add Pi skill-invocation
detection to `pi/actions.ts`; then enable Pi skills.

**Cross-cutting.**
- Per-harness fix-prompt templating — the fix text hardcodes "every Claude Code
  session's startup" and the config-edit instructions are harness-specific (different
  files/locations). Template the harness label + the "where to edit" guidance.
- Filter commands/prompts out of the installed skills set.
- Tests first (red→green): stub each new source path, confirm red for the right reason,
  then implement.

## Product questions to resolve

1. **Capability scope.** MCP + skills only (current), or also agents (and
   commands/prompts)? *Recommended:* mcp + skills now; explicitly exclude
   commands/prompts; defer agents (no invocation detection yet).
2. **Gapped harnesses.** Invest now to close the OpenCode-MCP and Pi-skill detection gaps,
   or ship what's ready (CC full, Codex mcp, OpenCode skills) and defer the gapped combos?
3. **Card granularity.** One card per harness (source-labeled; fix edits are
   harness-specific) vs one unified cross-harness card with per-source sections. Affects
   `signalKey` format and marker stability.
4. **Codex skill trust.** Is the shell-`SKILL.md`-read heuristic reliable enough to base a
   *removal* recommendation on, or ship Codex mcp-only until skill detection is firmer?
5. **Cross-harness usage semantics.** If the same repo is driven by two harnesses and a
   server is installed in both configs but used from only one, we flag it as unused in the
   other. *Recommended:* keep per-config (per-harness) — "remove it from the config that
   isn't using it" is the correct, actionable framing.
