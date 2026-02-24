/**
 * Chat mode provider abstraction
 *
 * Creates Anthropic SDK clients for different providers without mutating env vars.
 * Reuses the MODEL_PROVIDERS mapping from the main agent module.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SettingsManager } from '../settings';

type ProviderType = 'anthropic' | 'moonshot' | 'glm';

const MODEL_PROVIDERS: Record<string, ProviderType> = {
  'claude-opus-4-6': 'anthropic',
  'claude-opus-4-5-20251101': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  'kimi-k2.5': 'moonshot',
  'glm-5': 'glm',
  'glm-4.7': 'glm',
};

export function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}

/**
 * Create an Anthropic SDK client configured for the given model's provider.
 * No env vars are mutated — all config is passed directly to the constructor.
 */
export async function createChatClient(model: string): Promise<Anthropic> {
  const provider = getProviderForModel(model);

  if (provider === 'moonshot') {
    const apiKey = SettingsManager.get('moonshot.apiKey');
    if (!apiKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }
    return new Anthropic({
      apiKey,
      baseURL: 'https://api.moonshot.ai/anthropic/',
    });
  }

  if (provider === 'glm') {
    const apiKey = SettingsManager.get('glm.apiKey');
    if (!apiKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }
    return new Anthropic({
      apiKey,
      baseURL: 'https://api.z.ai/api/anthropic/',
    });
  }

  // Anthropic provider
  const apiKey = SettingsManager.get('anthropic.apiKey');
  if (apiKey) {
    return new Anthropic({ apiKey });
  }

  // Check for OAuth
  const authMethod = SettingsManager.get('auth.method');
  if (authMethod === 'oauth') {
    const { ClaudeOAuth } = await import('../auth/oauth');
    const token = await ClaudeOAuth.getAccessToken();
    if (token) {
      return new Anthropic({
        apiKey: token,
        authToken: token,
      });
    }
    throw new Error('OAuth session expired. Please re-authenticate in Settings.');
  }

  throw new Error('No API key configured. Please add your key in Settings.');
}
