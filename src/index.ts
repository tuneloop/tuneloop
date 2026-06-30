/**
 * Public library surface. Importing this also registers the built-in adapters
 * and processors, so consumers can analyze without extra wiring, while still
 * being able to register their own via the exported registry functions.
 */
import './register'

export * from './core/model'
export * from './core/processor'
export { registerAdapter, registerProcessor, getAdapters, getProcessors } from './core/registry'
export { orderProcessors, runProcessors } from './core/runner'
export type { RunOptions } from './core/runner'
export type { SourceAdapter } from './adapters/types'
export { Store } from './store/store'
export type { Summary } from './store/store'
export * from './store/types'
export { loadConfig } from './config'
export type { TuneloopConfig } from './config'
export { analyze } from './commands/analyze'
export type { AnalyzeOptions } from './commands/analyze'
export { serve } from './commands/serve'
export type { ServeOptions } from './commands/serve'
export { createDashboardServer } from './server/http'
export { priceFor, computeSessionCost, costOfUsage, PRICE_TABLE_VERSION } from './pricing/pricing'
export { createLlmClient } from './llm'
export type { LlmClient, LlmResult, StructuredRequest } from './llm/types'
