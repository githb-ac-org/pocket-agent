/**
 * Chat mode provider abstraction
 *
 * Creates Anthropic SDK clients for different providers without mutating env vars.
 * Uses the shared MODEL_PROVIDERS mapping from providers.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SettingsManager } from '../settings';
import { getProviderForModel } from './providers';

export { getProviderForModel };

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
      // OAuth tokens use Authorization: Bearer header, not x-api-key.
      // The oauth-2025-04-20 beta header is required for OAuth auth on the API.
      return new Anthropic({
        apiKey: null,
        authToken: token,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      });
    }
    throw new Error('OAuth session expired. Please re-authenticate in Settings.');
  }

  throw new Error('No API key configured. Please add your key in Settings.');
}
