import type { SourceAdapter } from '../adapters/types'
import type { Processor } from './processor'

/**
 * The two extension points. Adapters turn a vendor transcript into the
 * normalized model; processors derive facts from it. Built-ins register
 * themselves on import; third parties can register their own the same way.
 */
const adapters: SourceAdapter[] = []
const processors: Processor[] = []

export function registerAdapter(adapter: SourceAdapter): void {
  adapters.push(adapter)
}

export function registerProcessor(processor: Processor): void {
  processors.push(processor)
}

export function getAdapters(): SourceAdapter[] {
  return [...adapters]
}

export function getProcessors(): Processor[] {
  return [...processors]
}
