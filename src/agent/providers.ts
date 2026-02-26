/**
 * Shared provider configuration for LLM backends.
 * Single source of truth — imported by both coder mode (agent/index.ts)
 * and general/chat mode (chat-providers.ts).
 */

export type ProviderType = 'anthropic' | 'moonshot' | 'glm';

export interface ProviderConfig {
  baseUrl?: string;
}

export const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  'anthropic': {
    // No baseUrl = uses default Anthropic endpoint
  },
  'moonshot': {
    baseUrl: 'https://api.moonshot.ai/anthropic/',
  },
  'glm': {
    baseUrl: 'https://api.z.ai/api/anthropic/',
  },
};

// Model to provider mapping
export const MODEL_PROVIDERS: Record<string, ProviderType> = {
  // Anthropic models
  'claude-opus-4-6': 'anthropic',
  'claude-opus-4-5-20251101': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  // Moonshot/Kimi models
  'kimi-k2.5': 'moonshot',
  // Z.AI GLM models
  'glm-5': 'glm',
  'glm-4.7': 'glm',
};

export function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}
