import type { SourceAdapter } from '../adapters/types'
import type { Detector } from './detector'
import type { Processor } from './processor'

const adapters: SourceAdapter[] = []
const processors: Processor[] = []
const detectors: Detector[] = []

export function registerAdapter(adapter: SourceAdapter): void {
  adapters.push(adapter)
}

export function registerProcessor(processor: Processor): void {
  processors.push(processor)
}

export function registerDetector(detector: Detector): void {
  detectors.push(detector)
}

export function getAdapters(): SourceAdapter[] {
  return [...adapters]
}

export function getProcessors(): Processor[] {
  return [...processors]
}

export function getDetectors(): Detector[] {
  return [...detectors]
}
