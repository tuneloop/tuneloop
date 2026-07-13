import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

interface RunResult {
  code: number;
  tail: string;
}

function runAnalyze(args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, signal?: AbortSignal): Promise<RunResult> {
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
        const line = raw.trim();
        if (line) {
          lines.push(line);
          onLine(line);
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => resolve({ code: 1, tail: err.message }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 0, tail: lines.slice(-20).join("\n") });
    });
  });
}

/**
 * Collect enrichment credentials through pi's dialogs (not the CLI's own TTY
 * prompt, which can't run inside pi). Returns env overrides for the child, or
 * null to run static-only. If the user's environment already configures a
 * provider, we reuse it and skip the prompts.
 */
async function resolveEnrichment(ctx: any): Promise<NodeJS.ProcessEnv | null> {
  if (process.env.TUNELOOP_LLM_PROVIDER) return {}; // already configured via env — inherit as-is
  if (!ctx.hasUI) return null; // print/non-interactive: static analysis only

  const enable = await ctx.ui.confirm(
    "LLM enrichment?",
    "Label sessions (work type, complexity, success) and name shipped features using your own key. Session summaries go only to the provider you choose. Enable for this run?",
  );
  if (!enable) return null;

  const provider = await ctx.ui.select("Enrichment provider:", PROVIDERS);
  if (!provider) return null;

  const overrides: NodeJS.ProcessEnv = { TUNELOOP_LLM_PROVIDER: provider };
  if (!KEYLESS.has(provider)) {
    const key = await ctx.ui.input(`API key for ${provider} (used this run only):`);
    if (!key) return null;
    overrides.TUNELOOP_LLM_API_KEY = key;
  }
  return overrides;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tuneloop-analyze", {
    description: "Build or refresh the local tuneloop store from your AI coding sessions",
    handler: async (args, ctx) => {
      const userArgs = args.split(" ").map((a) => a.trim()).filter(Boolean);
      // Always run analyze-only: serving the dashboard blocks forever and is
      // pointless inside pi. Idempotent if the user already passed it.
      const analyzeArgs = userArgs.includes("--no-serve") ? userArgs : [...userArgs, "--no-serve"];

      const overrides = await resolveEnrichment(ctx);
      const env = { ...process.env, ...(overrides ?? {}) };
      const enriched = overrides ? "with LLM enrichment" : "static analysis only";

      ctx.ui.setStatus("tuneloop", `analyzing (${enriched})…`);
      const { code, tail } = await runAnalyze(
        analyzeArgs,
        env,
        (line) => ctx.ui.setStatus("tuneloop", line),
        ctx.signal,
      );
      ctx.ui.setStatus("tuneloop", "");

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
