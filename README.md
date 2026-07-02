# tuneloop

Local analytics for your AI coding sessions. **Count outcomes, not tokens.**

`tuneloop` reads your AI coding session transcripts (Claude Code, Codex, and
OpenCode today; Cursor next), links them to what they actually produced — files,
commits, merged PRs — and shows you the metrics that matter: outcome rate, cost
per shipped PR, tool and skill usage. Everything runs and stays **on your
machine**.

> Built by the team at [Tuneloop](https://tuneloop.io).

## Quick start

```bash
npx tuneloop analyze            # analyzes ~/.claude/projects, then opens the dashboard
```

That builds a local store, prints a summary, and serves the dashboard in your
browser. Point it at specific directories with a comma-separated list:

```bash
npx tuneloop analyze ~/.claude/projects,/path/to/more/sessions
```

Pass `--no-serve` to analyze only (no dashboard, no browser), or `--port <n>` to
serve on a different port:

```bash
npx tuneloop analyze --no-serve   # build the store and exit
```

### See the dashboard

The dashboard opens automatically after `analyze`. To serve an
already-analyzed store without re-running analysis:

```bash
npx tuneloop serve              # opens a local dashboard over the analyzed store
```

Tiles, spend-over-time, distributions (use-case / complexity / autonomy / success
/ models / tools), and a filterable session list with per-session transcripts —
all served locally from the SQLite store. `Ctrl+C` to stop.

### Optional: LLM enrichment

Static analysis (tokens, cost, tools, files, git/PR outcomes) needs no setup.
To also derive use-case, complexity, autonomy, and an LLM-judged success
signal, point tuneloop at **your own** LLM key — your session data goes only to the
provider you choose:

```bash
export TUNELOOP_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export TUNELOOP_LLM_MODEL=claude-haiku-4-5
npx tuneloop analyze
```

**Providers.** Pick a preset and supply its key; the model defaults sensibly and
is overridable with `TUNELOOP_LLM_MODEL` (or `--llm-model`). Anthropic and OpenAI
are native; everything else speaks the OpenAI-compatible API.

| `TUNELOOP_LLM_PROVIDER` | Key env | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | native |
| `openai` | `OPENAI_API_KEY` | native |
| `openrouter` | `OPENROUTER_API_KEY` | 400+ models via one key |
| `groq` | `GROQ_API_KEY` | fast; free tier |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `gemini` | `GEMINI_API_KEY` | Google, OpenAI-compatible endpoint |
| `together` / `fireworks` / `xai` | `TOGETHER_API_KEY` / `FIREWORKS_API_KEY` / `XAI_API_KEY` | |
| `ollama` | _(none)_ | local; `http://localhost:11434` |
| `openai-compatible` | `TUNELOOP_LLM_API_KEY` | any other host; set `TUNELOOP_LLM_BASE_URL` |

```bash
# A hosted provider — name it, never type a URL:
TUNELOOP_LLM_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... \
  npx tuneloop analyze --llm-model deepseek/deepseek-chat

# Fully local, no key, nothing leaves your machine:
npx tuneloop analyze --llm-provider ollama --llm-model qwen2.5

# Any other OpenAI-compatible host:
TUNELOOP_LLM_PROVIDER=openai-compatible TUNELOOP_LLM_BASE_URL=https://host/v1 \
TUNELOOP_LLM_API_KEY=… npx tuneloop analyze --llm-model my-model
```

Enrichment uses a single structured **tool call** per session, so pick a
**tool-call-capable model** (all the hosted defaults above qualify). Flags
`--llm-provider` / `--llm-model` / `--llm-base-url` override the env for one run;
the API key is always env-only.

**Local Ollama** needs two things 
(1) A bigger context window — the enrichment prompt is ~4–6k tokens, but Ollama's default
(~2k) silently truncates it, dropping the tool schema. Start the server with
`OLLAMA_CONTEXT_LENGTH=8192 ollama serve` (or a Modelfile `PARAMETER num_ctx
8192`)
(2) A capable model — use a tool-strong ≥7B like `qwen2.5:7b` or
`llama3.1`; tiny models (e.g. `qwen2.5:3b`) and reasoning-heavy ones tool-call
unreliably.

The cost of enrichment itself (one cheap call per session) is reported as
**Analysis spend** in the summary. Native and common models are priced from a
built-in table; for other models tuneloop fills the gap from OpenRouter's public,
no-auth price list (cached under `~/.tuneloop/`, refreshed daily) — unknown models
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
store (`~/.tuneloop/` by default). Your **session data** is sent nowhere unless you
enable LLM enrichment, and then only to the provider whose key you supply. (When
enrichment uses a model its built-in table can't price, tuneloop fetches a public,
no-auth **price list** from OpenRouter — no session data; static-only runs make
no network calls.) To keep everything on your machine, run enrichment against a
local model (`--llm-provider ollama`) — no key, no session data leaves the host.

## Run from source

`npx tuneloop` is all most people need. To hack on tuneloop itself, run it from a
local checkout instead:

```bash
npm install

# Optional: LLM enrichment — point tuneloop at your own LLM key. Your session data
# goes only to the vendor you choose. Skip these for static analysis only.
export TUNELOOP_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export TUNELOOP_LLM_MODEL=claude-haiku-4-5

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

`npm link` also works if you want a global `tuneloop` backed by your local build.

## Extending it

Adding new processing is one file. See [ARCHITECTURE.md](./ARCHITECTURE.md) —
implement the `Processor` interface, declare any sliceable facets, and register
it. It shows up in the store and the dashboard (as a slice-able card and filter)
automatically — no migration, no dashboard code.

## License

MIT
