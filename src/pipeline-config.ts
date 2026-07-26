import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Detector } from './core/detector'
import type { Processor } from './core/processor'
import type { Logger } from './util/log'

/**
 * Per-component knobs. Only `enabled` today; the object shape (rather than a bare
 * name list) deliberately leaves room for future per-processor/detector settings —
 * thresholds, a model tier — without a breaking config-schema change.
 */
export interface ComponentConfig {
  /** Defaults to true when the component's key is present. Set false to turn it off. */
  enabled?: boolean
}

/**
 * Which pipeline components `analyze` runs, from a JSON config file. Shipped as a
 * repo default that lists everything; a user copies it and edits down.
 *
 * A section that is OMITTED entirely means "run every component of that kind" (no
 * filtering). A section that is PRESENT is an allowlist — only keys with
 * `enabled !== false` run; anything absent from a present section is off.
 */
export interface PipelineConfig {
  processors?: Record<string, ComponentConfig>
  detectors?: Record<string, ComponentConfig>
}

export interface Pipeline {
  processors: Processor[]
  detectors: Detector[]
}

/**
 * The default config shipped in the repo/package. Resolved relative to the built
 * bundle exactly as `cli.ts` reads `package.json` — so it works in dev (src/), in
 * the bundle (dist/), and when installed from npm (config.json ships in `files`).
 */
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config.json', import.meta.url))

/**
 * Read a pipeline config from JSON. With an explicit `path` (the user's --config),
 * a missing or malformed file throws — a typo shouldn't silently fall back to
 * running everything. With no path, the shipped default is read; if that's somehow
 * absent (it always ships) the result is an empty config, which runs everything.
 */
export function loadPipelineConfig(path?: string): PipelineConfig {
  if (path) return parseConfig(readFileSync(path, 'utf8'), path)
  if (!existsSync(DEFAULT_CONFIG_PATH)) return {}
  return parseConfig(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'), DEFAULT_CONFIG_PATH)
}

function parseConfig(text: string, source: string): PipelineConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`invalid pipeline config at ${source}: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid pipeline config at ${source}: expected a JSON object`)
  }
  return raw as PipelineConfig
}

/** A component runs when its key is present in a section and not explicitly disabled. */
function isEnabled(entry: ComponentConfig | undefined): boolean {
  return entry != null && entry.enabled !== false
}

/**
 * Filter the available processors + detectors down to what `config` selects.
 * See {@link PipelineConfig} for the omitted-vs-present section rule. Config names
 * that match nothing available are warned and ignored; the `requires` deps of any
 * enabled processor are auto-enabled (warned) so a dependent can't be starved of
 * the data it reads (e.g. outcomes-git without segment-blocks). Registry order is
 * preserved in both returned lists.
 */
export function resolvePipeline(config: PipelineConfig, available: Pipeline, log: Logger): Pipeline {
  const selected = selectByConfig(available.processors, config.processors, 'processor', log)
  const detectors = selectByConfig(available.detectors, config.detectors, 'detector', log)
  const processors = ensureProcessorDeps(selected, available.processors, log)
  return { processors, detectors }
}

function selectByConfig<T extends { name: string }>(
  all: T[],
  section: Record<string, ComponentConfig> | undefined,
  kind: string,
  log: Logger,
): T[] {
  if (!section) return [...all] // omitted section → run everything of this kind
  const known = new Set(all.map((c) => c.name))
  for (const name of Object.keys(section)) {
    if (!known.has(name)) log.warn(`config lists unknown ${kind} "${name}" — ignoring`)
  }
  return all.filter((c) => isEnabled(section[c.name]))
}

/**
 * Pull in the `requires` deps of every selected processor (transitively). A
 * dependent without its dependency doesn't error today — orderProcessors just
 * drops the missing edge and the dependent runs against empty upstream data — so
 * auto-enabling with a warning is strictly safer than honoring an omission.
 */
function ensureProcessorDeps(selected: Processor[], all: Processor[], log: Logger): Processor[] {
  const byName = new Map(all.map((p) => [p.name, p]))
  const included = new Map(selected.map((p) => [p.name, p]))
  const queue = [...selected]
  while (queue.length) {
    const p = queue.shift()!
    for (const dep of p.requires ?? []) {
      if (included.has(dep)) continue
      const d = byName.get(dep)
      if (!d) continue // unknown dep name — orderProcessors already tolerates this
      included.set(dep, d)
      queue.push(d)
      log.warn(`enabling processor "${dep}" (required by "${p.name}")`)
    }
  }
  return all.filter((p) => included.has(p.name)) // registry order
}
