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
To also derive use-case, complexity, autonomy, and an LLM-judged success
signal, point aivue at **your own** LLM key — your session data goes only to the
provider you choose:

```bash
export AIVUE_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export AIVUE_LLM_MODEL=claude-haiku-4-5
npx aivue analyze
```

**Providers.** Pick a preset and supply its key; the model defaults sensibly and
is overridable with `AIVUE_LLM_MODEL` (or `--llm-model`). Anthropic and OpenAI
are native; everything else speaks the OpenAI-compatible API.

| `AIVUE_LLM_PROVIDER` | Key env | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | native |
| `openai` | `OPENAI_API_KEY` | native |
| `openrouter` | `OPENROUTER_API_KEY` | 400+ models via one key |
| `groq` | `GROQ_API_KEY` | fast; free tier |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `gemini` | `GEMINI_API_KEY` | Google, OpenAI-compatible endpoint |
| `together` / `fireworks` / `xai` | `TOGETHER_API_KEY` / `FIREWORKS_API_KEY` / `XAI_API_KEY` | |
| `ollama` | _(none)_ | local; `http://localhost:11434` |
| `openai-compatible` | `AIVUE_LLM_API_KEY` | any other host; set `AIVUE_LLM_BASE_URL` |

```bash
# A hosted provider — name it, never type a URL:
AIVUE_LLM_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... \
  npx aivue analyze --llm-model deepseek/deepseek-chat

# Fully local, no key, nothing leaves your machine:
npx aivue analyze --llm-provider ollama --llm-model qwen2.5

# Any other OpenAI-compatible host:
AIVUE_LLM_PROVIDER=openai-compatible AIVUE_LLM_BASE_URL=https://host/v1 \
AIVUE_LLM_API_KEY=… npx aivue analyze --llm-model my-model
```

Enrichment uses a single structured **tool call** per session, so pick a
**tool-call-capable model** (all the hosted defaults above qualify; for local
`ollama`, prefer `qwen2.5` / `llama3.1` over tiny non-tool models). Flags
`--llm-provider` / `--llm-model` / `--llm-base-url` override the env for one run;
the API key is always env-only.

The cost of enrichment itself (one cheap call per session) is reported as
**Analysis spend** in the summary. Native and common models are priced from a
built-in table; for other models aivue fills the gap from OpenRouter's public,
no-auth price list (cached under `~/.aivue/`, refreshed daily) — unknown models
just read `$0`. It's best-effort and never blocks a run.

If no provider is configured, `analyze` runs static-only and prints a one-time
hint on how to turn enrichment on.

## What it captures (out of the box)

- **Cost** — per-session and per-model, from token usage × a static price table.
- **Outcomes** — files written, commits, PRs created, and PR-merged status
  (queried live via your local `gh`/`git`, skipped gracefully when offline).
- **Tool & skill usage** — counts and error rates across every session.
- **Cost per merged PR** — the same windowed unit-cost metric, at the PR level.

## Privacy

Transcripts are processed locally and results are written to a local SQLite
store (`~/.aivue/` by default). Your **session data** is sent nowhere unless you
enable LLM enrichment, and then only to the provider whose key you supply. (When
enrichment uses a model its built-in table can't price, aivue fetches a public,
no-auth **price list** from OpenRouter — no session data; static-only runs make
no network calls.) To keep everything on your machine, run enrichment against a
local model (`--llm-provider ollama`) — no key, no session data leaves the host.

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
