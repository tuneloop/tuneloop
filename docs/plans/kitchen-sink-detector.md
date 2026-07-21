# Kitchen-Sink Session Detector (AL-83)

## What it does

A kitchen-sink session is one where the person did several unrelated jobs in a single
session instead of splitting them into separate sessions. This detector finds those
sessions, confirms with the AI that the jobs were truly unrelated, and shows the person
where the session should have been split.

## Why two layers

The work splits into a cheap layer and an AI layer.

- **Cheap layer (no AI):** a database-only pre-gate that picks candidate sessions. This
keeps the AI off short or single-purpose sessions, which saves cost and avoids wrong flags.
- **AI layer:** only runs on the candidates. It makes the hard judgment — are the jobs
genuinely unrelated, and where is the split point — because a database count cannot tell
"did two separate things" from "did one connected thing that touched two areas".



## The pre-gate (cheap layer, no AI)

A session is a candidate when BOTH are true:

1. It is a larger session (see "real user-turn count" below), AND
2. It advanced 2+ distinct features OR opened/touched 2+ distinct PRs.

Both numbers are read from data that already exists. Feature links come from the
enrich-session processor; PR links come from the outcomes-git processor.

### Real user-turn count

A real user turn is a time a human actually typed a new instruction. This is NOT the raw
turn count and NOT the block count — block count is larger because a new block also starts
after each commit and PR, not only after a human message.

Get the count from block data:

```
real user turns = 1 (opening block)
                + number of blocks whose boundaryKind is 'user_turn'
```

Blocks that ended on a commit or PR are deliberately not counted — they were not human
instructions.

### The size threshold

Take all sessions in a recent window, sort by real user-turn count, and use a high
percentile (default: 75th, i.e. the longest 25%) as the cutoff. This adjusts to the actual
data instead of a fixed number.

Two settings to confirm against real data before coding:

- **Per repo or global?**: per repo, so a repo with naturally long sessions does not crowd out a repo with short ones.
- **Window length:** Default 30 days

Note: if most sessions in an account are long, the size threshold does little useful work
(length is that account's normal style). That is safe — the features/PRs condition does the
real filtering, and the AI is the final judge. A fixed small floor (e.g. 3+ turns) is an
alternative to the percentile if the data shows length is not meaningful.

## Only check unseen sessions

Use the existing delta helpers so the AI does not re-run on sessions it already judged:

- `store.detectorUnseen('kitchen-sink')` returns new or changed sessions.
- `store.markDetectorSessionSeen(...)` records a session as judged.

Apply the pre-gate to the unseen set, so the AI only runs on new candidates.

## The AI input

For each candidate, build the block digest with the existing `blockSpine(session, blocks)`.
It produces one numbered line per block:

- the block number,
- the human message that opened the block, or "(continued work — no new prompt)" if the
block did not start with a human message,
- what the block did (file writes, shell commands),
- how the block ended (commit, opened a PR, and so on).

The block numbers matter: the AI uses them to say where the split should have happened.

There is no public way for a detector to load the full session transcript today, and we do
not add one. The block digest plus the already-stored labels are enough.

## The AI judgment

Send the digest with a forced structured-output tool. Ask three things:

1. Are 2+ of these blocks pursuing unrelated jobs? (yes/no)
2. If yes, which block number is where a new unrelated job started? (the split point)
3. A one-sentence reason.

Tell the AI to answer "no" when unsure. It is better to miss some kitchen-sink sessions
than to wrongly flag coherent work — wrong flags train people to ignore the tab.

Output shape:

```
{
  isKitchenSink: boolean
  splitBlockIdx: integer   // block where the second job began
  reason: string
}
```



## Turning a "yes" into an insight

For each session marked as kitchen-sink, return one `InsightInput`:


| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| signalKey   | `kitchen-sink:<sessionId>` — one card per flagged session                                    |
| repo        | the session's repo                                                                           |
| severity    | `medium`; `high` when 3+ distinct jobs                                                       |
| title       | plain, e.g. "Session did unrelated jobs — split next time"                                   |
| description | what the jobs were and that they were unrelated, using the AI's reason                       |
| evidence    | one ref: session id + `turnIdx` = the `startSeq` of the split-point block                    |
| count       | number of distinct jobs found                                                                |
| fix         | `type: 'behavioral-nudge'`, content: plainly say to start a fresh session at the split point |


The existing runner saves these and the existing Insights tab shows them. No UI work needed.

## Loop metric

Success is the flagged-session rate: of the sessions checked, how many were flagged. Over
time this should fall as people start splitting their work. It is a soft signal — the fix is
a nudge with no exact adoption marker (behavioral-nudge maps to adoption signal `none`), so
track the rate as the detector's health number, not as part of any single insight.

## Build order

1. Pre-gate only (no AI): write the query, run it on the existing database, and count how
  many sessions clear the gate. Confirm it is neither letting everything through nor
   blocking everything. Cheap to check.
2. AI layer: digest, judgment, insight output.

## Detector fields

```
name: 'kitchen-sink'
version: 1
tier: 'P'
needsLlm: true
```

Register in `src/detectors/index.ts` with one import line, per the framework doc.