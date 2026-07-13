import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve the tuneloop CLI bundled inside this package. pi installs the package
// with its `dist/` output and runs `npm install`, so the CLI and its runtime
// dependencies are present on disk next to this extension.
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const DEFAULT_PORT = 4319;

// Mirrors the provider presets in src/llm. Keep in sync with the CLI.
const PROVIDERS = ["anthropic", "openai", "bedrock", "openrouter", "groq", "deepseek", "gemini", "ollama"];
// Providers that authenticate without an API key (local/ambient creds).
const KEYLESS = new Set(["ollama", "bedrock"]);

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "analyze", label: "analyze  build/refresh the store, then serve the dashboard" },
  { value: "open", label: "open  serve (if needed) and open the dashboard in your browser" },
  { value: "stop", label: "stop  stop the background dashboard server" },
  { value: "status", label: "status  show whether the dashboard is running" },
  { value: "help", label: "help  show usage and analyze options" },
];

// Passthrough flags for `analyze`, mirroring `tuneloop analyze --help`. Keep in sync with the CLI.
const FLAGS: AutocompleteItem[] = [
  { value: "--source ", label: "--source <name>  limit to harnesses (repeatable; NAME or NAME=DIR)" },
  { value: "--limit ", label: "--limit <n>  process at most N sessions" },
  { value: "--db ", label: "--db <path>  path to the tuneloop SQLite store" },
  { value: "--port ", label: "--port <n>  dashboard port (default 4319)" },
  { value: "--llm-provider ", label: "--llm-provider <name>  enrichment provider preset" },
  { value: "--llm-model ", label: "--llm-model <id>  enrichment model id" },
  { value: "--llm-base-url ", label: "--llm-base-url <url>  OpenAI-compatible endpoint" },
  { value: "--verbose", label: "--verbose  verbose logging" },
];

const HELP = [
  "/tuneloop — local analytics for your AI coding sessions.",
  "",
  "  /tuneloop analyze [flags]  Build/refresh the store, then serve the dashboard",
  "                             in the background and print its URL. Restarts an",
  "                             already-running dashboard.",
  "  /tuneloop open             Serve (if needed) and open the dashboard in a browser.",
  "  /tuneloop stop             Stop the background dashboard server.",
  "  /tuneloop status           Show whether the dashboard is running.",
  "  /tuneloop help             Show this help plus the analyze flags below.",
  "",
  "LLM enrichment is optional but recommended. Without it you get static analysis;",
  "with it, each session is labeled (work type, complexity, autonomy, judged success)",
  "and the features you shipped are named — using your own key. You are asked once per",
  "analyze run, or set TUNELOOP_LLM_PROVIDER (+ key) to skip the prompt. Session",
  "summaries go only to the provider you choose.",
  "",
  "analyze flags (passed through to `tuneloop analyze`):",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Background dashboard server (session-scoped). Never started from the factory;
// only from a command. Cleaned up in session_shutdown so we don't leak it.
// ---------------------------------------------------------------------------
let server: { child: ChildProcess; port: number; url: string } | null = null;

function stopServer(): boolean {
  if (!server) return false;
  server.child.kill();
  server = null;
  return true;
}

/** Spawn `serve --no-open` in the background; resolve once it reports its URL. */
function startServer(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${port}`;
    const child = spawn(process.execPath, [cliPath, "serve", "--no-open", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.unref(); // don't keep pi's event loop alive on our account
    let settled = false;
    let errBuf = "";
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (b: Buffer) => {
      if (b.toString().includes(url)) done(() => { server = { child, port, url }; resolve(url); });
    });
    child.stderr.on("data", (b: Buffer) => {
      errBuf += b.toString();
      if (/in use|EADDRINUSE|error/i.test(errBuf)) done(() => { child.kill(); reject(new Error(errBuf.trim())); });
    });
    child.on("error", (err) => done(() => reject(err)));
    child.on("exit", (code) => {
      if (server?.child === child) server = null; // it died later — forget it
      done(() => reject(new Error(errBuf.trim() || `serve exited (code ${code})`)));
    });
    // Fallback: assume it's up if it neither printed the URL nor errored in time.
    const timer = setTimeout(() => done(() => { server = { child, port, url }; resolve(url); }), 8000);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {/* best effort */});
}

function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1]!, 10);
    if (Number.isFinite(n)) return n;
  }
  return server?.port ?? DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// analyze (foreground child)
// ---------------------------------------------------------------------------
interface RunResult {
  code: number;
  lines: string[];
}

function runAnalyze(args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    // stdin ignored so the child never sees a TTY (its interactive enrichment
    // prompt is skipped and can't collide with pi's terminal); stdout/stderr
    // piped (not inherited) so its progress output can't corrupt pi's TUI.
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
async function resolveEnrichment(ctx: ExtensionContext): Promise<NodeJS.ProcessEnv | null> {
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

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------
async function doAnalyze(pi: ExtensionAPI, ctx: ExtensionContext, args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    const { lines } = await runAnalyze(["--help"], process.env, undefined, ctx.signal);
    pi.sendMessage({ customType: "tuneloop", content: HELP + lines.join("\n"), display: true });
    return;
  }

  // Restart cleanly: stop any dashboard bound to the store we're about to rebuild.
  stopServer();

  const overrides = await resolveEnrichment(ctx);
  const env = { ...process.env, ...(overrides ?? {}) };
  const enriched = overrides ? "with LLM enrichment" : "static analysis only";

  ctx.ui.setStatus("tuneloop", `analyzing (${enriched})…`);
  const { code, lines } = await runAnalyze(
    [...args, "--no-serve"], // serving is handled by our background server below
    env,
    (line) => ctx.ui.setStatus("tuneloop", line),
    ctx.signal,
  );

  const tail = lines.slice(-20).join("\n");
  if (code !== 0) {
    ctx.ui.setStatus("tuneloop", "");
    ctx.ui.notify(`tuneloop analyze failed (exit ${code})`, "error");
    pi.sendMessage({ customType: "tuneloop", content: tail || `Exited with code ${code}`, display: true });
    return;
  }

  // Analyze succeeded — bring the dashboard up in the background and report the URL.
  ctx.ui.setStatus("tuneloop", "starting dashboard…");
  try {
    const url = await startServer(parsePort(args));
    ctx.ui.setStatus("tuneloop", `dashboard: ${url}`);
    ctx.ui.notify(`tuneloop analyze complete — dashboard at ${url}`, "info");
    pi.sendMessage({
      customType: "tuneloop",
      content: `${tail}\n\nDashboard: ${url}\n(\`/tuneloop open\` to open it · \`/tuneloop stop\` to stop it)`,
      display: true,
    });
  } catch (err) {
    ctx.ui.setStatus("tuneloop", "");
    ctx.ui.notify(`analyze complete, but dashboard failed: ${(err as Error).message}`, "warning");
    pi.sendMessage({ customType: "tuneloop", content: tail, display: true });
  }
}

async function doOpen(ctx: ExtensionContext, args: string[]) {
  if (!server) {
    ctx.ui.setStatus("tuneloop", "starting dashboard…");
    try {
      await startServer(parsePort(args));
    } catch (err) {
      ctx.ui.setStatus("tuneloop", "");
      ctx.ui.notify(`could not start dashboard: ${(err as Error).message}`, "error");
      return;
    }
  }
  const url = server!.url;
  ctx.ui.setStatus("tuneloop", `dashboard: ${url}`);
  openBrowser(url);
  ctx.ui.notify(`Opening ${url}`, "info");
}

function doStop(ctx: ExtensionContext) {
  if (stopServer()) {
    ctx.ui.setStatus("tuneloop", "");
    ctx.ui.notify("tuneloop dashboard stopped.", "info");
  } else {
    ctx.ui.notify("No tuneloop dashboard is running.", "info");
  }
}

function doStatus(ctx: ExtensionContext) {
  ctx.ui.notify(server ? `tuneloop dashboard running at ${server.url}` : "tuneloop dashboard is not running.", "info");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => { stopServer(); });

  pi.registerCommand("tuneloop", {
    description: "Analyze your AI coding sessions and serve the local dashboard (analyze | open | stop | status). LLM enrichment optional, recommended.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const pool = [...SUBCOMMANDS, ...FLAGS];
      const matches = pool.filter((i) => i.value.trim().startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.split(" ").map((a) => a.trim()).filter(Boolean);
      const sub = tokens[0]?.toLowerCase();
      const rest = tokens.slice(1);

      switch (sub) {
        case undefined:
        case "help":
        case "--help":
        case "-h": {
          const { lines } = await runAnalyze(["--help"], process.env, undefined, ctx.signal);
          pi.sendMessage({ customType: "tuneloop", content: HELP + lines.join("\n"), display: true });
          return;
        }
        case "analyze":
          return doAnalyze(pi, ctx, rest);
        case "open":
          return doOpen(ctx, rest);
        case "stop":
          return doStop(ctx);
        case "status":
          return doStatus(ctx);
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". Try /tuneloop help.`, "error");
      }
    },
  });
}
