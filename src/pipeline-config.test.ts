import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_PATH, loadPipelineConfig, resolvePipeline } from './pipeline-config'
import type { Pipeline, PipelineConfig } from './pipeline-config'
import type { Processor } from './core/processor'
import type { Detector } from './core/detector'
import type { Logger } from './util/log'
import './register'
import { getDetectors, getProcessors } from './core/registry'

// Minimal fakes — resolvePipeline only reads name + requires.
const proc = (name: string, requires?: string[]): Processor => ({
  name,
  version: 1,
  kind: 'static',
  requires,
  run: () => ({}),
})
const det = (name: string): Detector => ({ name, version: 1, tier: 'S', run: () => [] })

const fakeLog = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const silent = fakeLog()

const available = (): Pipeline => ({
  processors: [proc('segment-blocks'), proc('files-touched'), proc('enrich-session', ['segment-blocks'])],
  detectors: [det('cache-miss'), det('kitchen-sink')],
})

describe('resolvePipeline — selection', () => {
  it('runs every component of a kind whose section is omitted', () => {
    const r = resolvePipeline({ detectors: { 'cache-miss': { enabled: true } } }, available(), silent)
    // processors section omitted → all three run; detectors section present → allowlist
    expect(r.processors.map((p) => p.name)).toEqual(['segment-blocks', 'files-touched', 'enrich-session'])
    expect(r.detectors.map((d) => d.name)).toEqual(['cache-miss'])
  })

  it('treats a present section as an allowlist (enabled:false and absent names are off)', () => {
    const cfg: PipelineConfig = {
      processors: { 'files-touched': { enabled: true }, 'segment-blocks': { enabled: false } },
    }
    const r = resolvePipeline(cfg, available(), silent)
    // files-touched on; segment-blocks explicitly off; enrich-session absent → off
    expect(r.processors.map((p) => p.name)).toEqual(['files-touched'])
  })

  it('treats a present-but-empty section as "none of that kind"', () => {
    const r = resolvePipeline({ detectors: {} }, available(), silent)
    expect(r.detectors).toEqual([])
  })

  it('counts a bare {} entry as enabled (enabled defaults true when the key is present)', () => {
    const r = resolvePipeline({ detectors: { 'kitchen-sink': {} } }, available(), silent)
    expect(r.detectors.map((d) => d.name)).toEqual(['kitchen-sink'])
  })

  it('preserves registry order regardless of config key order', () => {
    const cfg: PipelineConfig = {
      processors: { 'enrich-session': {}, 'files-touched': {}, 'segment-blocks': {} },
    }
    const r = resolvePipeline(cfg, available(), silent)
    expect(r.processors.map((p) => p.name)).toEqual(['segment-blocks', 'files-touched', 'enrich-session'])
  })
})

describe('resolvePipeline — unknown names', () => {
  it('warns on a config name that matches nothing available and ignores it', () => {
    const log = fakeLog()
    const r = resolvePipeline({ detectors: { nope: { enabled: true } } }, available(), log)
    expect(r.detectors).toEqual([]) // nope matches nothing; cache-miss/kitchen-sink absent from allowlist → off
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('nope'))
  })
})

describe('resolvePipeline — processor dependencies', () => {
  const deps = (): Pipeline => ({
    processors: [proc('segment-blocks'), proc('outcomes-git', ['segment-blocks'])],
    detectors: [],
  })

  it('auto-enables a required processor omitted from the allowlist (and warns)', () => {
    const log = fakeLog()
    const r = resolvePipeline({ processors: { 'outcomes-git': { enabled: true } } }, deps(), log)
    expect(r.processors.map((p) => p.name)).toEqual(['segment-blocks', 'outcomes-git'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('segment-blocks'))
  })

  it('auto-enables a required processor even when it was explicitly disabled (a dependent would break without it)', () => {
    const log = fakeLog()
    const cfg: PipelineConfig = {
      processors: { 'outcomes-git': { enabled: true }, 'segment-blocks': { enabled: false } },
    }
    const r = resolvePipeline(cfg, deps(), log)
    expect(r.processors.map((p) => p.name)).toEqual(['segment-blocks', 'outcomes-git'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('segment-blocks'))
  })
})

describe('shipped default config', () => {
  it('enables every registered processor and detector (drift guard)', () => {
    const cfg = loadPipelineConfig() // no path → the shipped default at DEFAULT_CONFIG_PATH
    const procNames = getProcessors().map((p) => p.name).sort()
    const detNames = getDetectors().map((d) => d.name).sort()
    expect(Object.keys(cfg.processors ?? {}).sort()).toEqual(procNames)
    expect(Object.keys(cfg.detectors ?? {}).sort()).toEqual(detNames)
    for (const c of Object.values(cfg.processors ?? {})) expect(c.enabled).not.toBe(false)
    for (const c of Object.values(cfg.detectors ?? {})) expect(c.enabled).not.toBe(false)
  })

  it('resolving the default selects the full registry', () => {
    const r = resolvePipeline(loadPipelineConfig(), { processors: getProcessors(), detectors: getDetectors() }, silent)
    expect(r.processors.length).toBe(getProcessors().length)
    expect(r.detectors.length).toBe(getDetectors().length)
  })

  it('DEFAULT_CONFIG_PATH points at a readable JSON file', () => {
    expect(() => loadPipelineConfig(DEFAULT_CONFIG_PATH)).not.toThrow()
  })
})

describe('loadPipelineConfig — errors', () => {
  it('throws on an explicit path that does not exist', () => {
    expect(() => loadPipelineConfig('/no/such/tuneloop-config.json')).toThrow()
  })
})
