import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve the tuneloop CLI bundled inside this package. pi installs the package
// with its `dist/` output and runs `npm install`, so the CLI and its runtime
// dependencies are present on disk next to this extension.
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runAnalyze(args: string[], signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "analyze", ...args], {
      stdio: "inherit",
    });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => resolve(1));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(code ?? 0);
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tuneloop-analyze", {
    description: "Build or refresh the local tuneloop store from your AI coding sessions",
    handler: async (args, ctx) => {
      const parsed = args.split(" ").map((a) => a.trim()).filter(Boolean);
      ctx.ui.setStatus("tuneloop", "analyzing…");
      const code = await runAnalyze(parsed, ctx.signal);
      ctx.ui.setStatus("tuneloop", "");
      if (code === 0) {
        ctx.ui.notify("tuneloop analyze complete", "info");
      } else {
        ctx.ui.notify(`tuneloop analyze exited with code ${code}`, "error");
      }
    },
  });
}
