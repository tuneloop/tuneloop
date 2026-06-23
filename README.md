# aivue

Local analytics for your AI coding sessions. **Count outcomes, not tokens.**

`aivue` reads your AI coding session transcripts (Claude Code today; Codex and
Cursor next), links them to what they actually produced — files, commits, merged
PRs — and shows you the metrics that matter: outcome rate, cost per shipped PR,
tool and skill usage. Everything runs and stays **on your machine**.

> Built by the team at [Tuneloop](https://tuneloop.io).

## Quick start

```bash
npx aivue analyze            # analyzes ~/.claude/projects, then opens the dashboard
```

That builds a local store, prints a summary, and serves the dashboard in your
browser. Point it at specific directories with a comma-separated list:

```bash
npx aivue analyze ~/.claude/projects,/path/to/more/sessions
```

Pass `--no-serve` to analyze only (no dashboard, no browser), or `--port <n>` to
serve on a different port:

```bash
npx aivue analyze --no-serve   # build the store and exit
```

### See the dashboard

The dashboard opens automatically after `analyze`. To serve an
already-analyzed store without re-running analysis:

```bash
npx aivue serve              # opens a local dashboard over the analyzed store
```

Tiles, spend-over-time, distributions (use-case / complexity / autonomy / success
/ models / tools), and a filterable session list with per-session transcripts —
all served locally from the SQLite store. `Ctrl+C` to stop.

### Optional: LLM enrichment

Static analysis (tokens, cost, tools, files, git/PR outcomes) needs no setup.
To also derive topics, use-case, complexity, autonomy, and an LLM-judged success
signal, point aivue at **your own** LLM key — your session data goes only to the
vendor you choose:

```bash
export AIVUE_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export AIVUE_LLM_MODEL=claude-haiku-4-5
npx aivue analyze
```

## What it captures (out of the box)

- **Cost** — per-session and per-model, from token usage × a static price table.
- **Outcomes** — files written, commits, PRs created, and PR-merged status
  (queried live via your local `gh`/`git`, skipped gracefully when offline).
- **Tool & skill usage** — counts and error rates across every session.
- **Cost per merged PR** — the same windowed unit-cost metric, at the PR level.

## Privacy

Transcripts are processed locally and results are written to a local SQLite
store (`~/.aivue/` by default). Nothing is sent anywhere unless you enable LLM
enrichment, and then only to the provider whose key you supply.

## Run from source

`aivue` isn't published yet, so `npx aivue` won't resolve. Until it is, run it
from a local checkout:

```bash
npm install

# Optional: LLM enrichment — point aivue at your own LLM key. Your session data
# goes only to the vendor you choose. Skip these for static analysis only.
export AIVUE_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export AIVUE_LLM_MODEL=claude-haiku-4-5

npm run dev -- analyze        # builds, runs the CLI (args after `--`), then opens the dashboard
```

`analyze` serves the dashboard when it finishes, so that one command is usually
all you need. To serve an already-analyzed store without re-running analysis,
run `serve` separately:

```bash
npm run dev -- serve
```

Or build once and call the binary directly:

```bash
npm run build
node dist/cli.js analyze
```

`npm link` also works if you want a global `aivue` backed by your local build.

## Extending it

Adding new processing is one file. See [ARCHITECTURE.md](./ARCHITECTURE.md) —
implement the `Processor` interface, declare any sliceable dimensions, and
register it. It shows up in the store (and, later, the dashboard) automatically.

## License

MIT
