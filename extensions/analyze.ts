import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve the tuneloop CLI bundled inside this package. pi installs the package
// with its `dist/` output and runs `npm install`, so the CLI and its runtime
// dependencies are present on disk next to this extension.
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// Mirrors the provider presets in src/llm. Keep in sync with the CLI.
const PROVIDERS = ["anthropic", "openai", "bedrock", "openrouter", "groq", "deepseek", "gemini", "ollama"];
// Providers that authenticate without an API key (local/ambient creds).
const KEYLESS = new Set(["ollama", "bedrock"]);

// Passthrough flags, mirroring `tuneloop analyze --help`. Keep in sync with the CLI.
const FLAGS: AutocompleteItem[] = [
  { value: "--source ", label: "--source <name>  limit to harnesses (repeatable; NAME or NAME=DIR)" },
  { value: "--limit ", label: "--limit <n>  process at most N sessions" },
  { value: "--db ", label: "--db <path>  path to the tuneloop SQLite store" },
  { value: "--llm-provider ", label: "--llm-provider <name>  enrichment provider preset" },
  { value: "--llm-model ", label: "--llm-model <id>  enrichment model id" },
  { value: "--llm-base-url ", label: "--llm-base-url <url>  OpenAI-compatible endpoint" },
  { value: "--verbose", label: "--verbose  verbose logging" },
  { value: "--help", label: "--help  show analyze options" },
];

// Note prepended to `--help` output: what differs when analyze runs inside pi.
const PI_NOTE = [
  "/tuneloop-analyze runs `tuneloop analyze` over your local AI coding sessions.",
  "",
  "LLM enrichment is optional but recommended. Without it you get static analysis;",
  "with it, each session is labeled (work type, complexity, autonomy, judged success)",
  "and the features you shipped are named — using your own key. You are asked once per",
  "run, or set TUNELOOP_LLM_PROVIDER (+ key) to skip the prompt. Session summaries go",
  "only to the provider you choose.",
  "",
  "The dashboard server is disabled here (--no-serve is added automatically). Run",
  "`tuneloop analyze` in a terminal to serve the dashboard.",
  "",
  "Arguments pass through to the CLI:",
  "",
].join("\n");

interface RunResult {
  code: number;
  lines: string[];
}

function runAnalyze(args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    // stdin is ignored so the child never sees a TTY: its interactive
    // enrichment prompt is skipped, and it can't collide with pi's terminal.
    // stdout/stderr are piped (not inherited) so progress output can't corrupt
    // pi's TUI — we surface it through pi's own UI instead.
    const child = spawn(process.execPath, [cliPath, "analyze", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const lines: string[] = [];
    const consume = (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (line.trim()) {
          lines.push(line);
          onLine?.(line.trim());
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => resolve({ code: 1, lines: [err.message] }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 0, lines });
    });
  });
}

/**
 * Collect enrichment credentials through pi's dialogs (not the CLI's own TTY
 * prompt, which can't run inside pi). Returns env overrides for the child, or
 * null to run static-only. Enrichment is optional but recommended; if the
 * user's environment already configures a provider, we reuse it and skip the
 * prompts.
 */
async function resolveEnrichment(ctx: any): Promise<NodeJS.ProcessEnv | null> {
  if (process.env.TUNELOOP_LLM_PROVIDER) return {}; // already configured via env — inherit as-is
  if (!ctx.hasUI) return null; // print/non-interactive: static analysis only

  const enable = await ctx.ui.confirm(
    "LLM enrichment? (optional, recommended)",
    "Recommended: label each session with work type, complexity, autonomy, and judged success, and name the features you shipped — using your own key. Session summaries go only to the provider you choose. Decline to run static analysis only. Enable for this run?",
  );
  if (!enable) {
    ctx.ui.notify("Running static analysis only — enrichment is optional.", "info");
    return null;
  }

  const provider = await ctx.ui.select("Enrichment provider:", PROVIDERS);
  if (!provider) {
    ctx.ui.notify("No provider selected — running static analysis only.", "info");
    return null;
  }

  const overrides: NodeJS.ProcessEnv = { TUNELOOP_LLM_PROVIDER: provider };
  if (!KEYLESS.has(provider)) {
    const key = await ctx.ui.input(`API key for ${provider} (used this run only):`);
    if (!key) {
      ctx.ui.notify("No key entered — running static analysis only.", "info");
      return null;
    }
    overrides.TUNELOOP_LLM_API_KEY = key;
  }
  return overrides;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tuneloop-analyze", {
    description: "Analyze your AI coding sessions into the local tuneloop store (LLM enrichment optional, recommended). Args pass to `tuneloop analyze`; use --help for options.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const matches = FLAGS.filter((f) => f.value.trim().startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const userArgs = args.split(" ").map((a) => a.trim()).filter(Boolean);

      // Help intercept: show the CLI's full usage plus a pi-specific note,
      // instead of treating --help as an analyze run.
      if (userArgs.includes("--help") || userArgs.includes("-h")) {
        const { lines } = await runAnalyze(["--help"], process.env, undefined, ctx.signal);
        pi.sendMessage({ customType: "tuneloop-analyze", content: PI_NOTE + lines.join("\n"), display: true });
        return;
      }

      // Always run analyze-only: serving the dashboard blocks forever and is
      // pointless inside pi. Idempotent if the user already passed it.
      const analyzeArgs = userArgs.includes("--no-serve") ? userArgs : [...userArgs, "--no-serve"];

      const overrides = await resolveEnrichment(ctx);
      const env = { ...process.env, ...(overrides ?? {}) };
      const enriched = overrides ? "with LLM enrichment" : "static analysis only";

      ctx.ui.setStatus("tuneloop", `analyzing (${enriched})…`);
      const { code, lines } = await runAnalyze(
        analyzeArgs,
        env,
        (line) => ctx.ui.setStatus("tuneloop", line),
        ctx.signal,
      );
      ctx.ui.setStatus("tuneloop", "");

      const tail = lines.slice(-20).join("\n");
      if (code === 0) {
        ctx.ui.notify("tuneloop analyze complete", "info");
        // Surface the summary in the transcript so the user (and the model) can see it.
        pi.sendMessage({ customType: "tuneloop-analyze", content: tail, display: true });
      } else {
        ctx.ui.notify(`tuneloop analyze failed (exit ${code})`, "error");
        pi.sendMessage({ customType: "tuneloop-analyze", content: tail || `Exited with code ${code}`, display: true });
      }
    },
  });
}
