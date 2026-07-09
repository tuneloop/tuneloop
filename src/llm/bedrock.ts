import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { anthropicShapedClient } from './anthropic'
import type { ClientOpts, LlmClient } from './types'

/**
 * AWS Bedrock-backed client (bedrock-runtime endpoint). Auth: a Bedrock API key
 * (bearer) when configured, else the SDK's AWS credential chain — env keys,
 * ~/.aws profiles, SSO, instance roles (SigV4). Region comes from AWS_REGION
 * (SDK default us-east-1); TUNELOOP_LLM_BASE_URL overrides the endpoint.
 * Bedrock speaks the Anthropic Messages API, so Claude models only.
 *
 * Deliberately the classic bedrock-runtime client, not the newer Mantle
 * endpoint: inference-profile ids on bedrock-runtime are what existing
 * Bedrock API keys and IAM model-access grants are provisioned for.
 */
export function createBedrockClient(apiKey: string, model: string, opts?: ClientOpts): LlmClient {
  // Empty key = "no bearer token" — leave apiKey unset so the SDK falls through
  // to AWS_BEARER_TOKEN_BEDROCK / the AWS credential chain on its own.
  const client = new AnthropicBedrock({ apiKey: apiKey || undefined, baseURL: opts?.baseURL })
  // Bedrock rejects forced tool_choice while thinking could run. Sonnet 5 thinks
  // by default so it needs the explicit opt-out; sent only for that family since
  // always-on-thinking models reject an explicit disable
  const extra = /sonnet-5/.test(model) ? { thinking: { type: 'disabled' as const } } : undefined
  return anthropicShapedClient(client, opts?.provider ?? 'bedrock', model, extra)
}
