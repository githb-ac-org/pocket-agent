/**
 * Chat mode tool adapter
 *
 * Converts existing tool definitions to Anthropic Messages API format
 * and adds web_search / web_fetch capabilities.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getCustomTools, ToolsConfig } from '../tools';
import { wrapToolHandler } from '../tools/diagnostics';
import { getProviderForModel } from './chat-providers';

type Tool = Anthropic.Messages.Tool;

// Web search tool type (server-side, not in all SDK versions)
interface WebSearchToolDef {
  type: 'web_search_20250305';
  name: 'web_search';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool | WebSearchToolDef | any;

export interface ChatToolSet {
  apiTools: AnyTool[];
  handlerMap: Map<string, (input: Record<string, unknown>) => Promise<string>>;
}

/**
 * Build the tool set for Chat mode.
 * Wraps each handler with diagnostics and returns both API definitions and a handler map.
 */
export function getChatToolDefinitions(config: ToolsConfig): ChatToolSet {
  const customTools = getCustomTools(config);
  const apiTools: AnyTool[] = [];
  const handlerMap = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  for (const tool of customTools) {
    const wrapped = wrapToolHandler(tool.name, tool.handler);

    apiTools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Tool['input_schema'],
    });

    handlerMap.set(tool.name, wrapped as (input: Record<string, unknown>) => Promise<string>);
  }

  // Add web_fetch as a custom tool
  const webFetchDef = getWebFetchTool();
  apiTools.push(webFetchDef.definition);
  handlerMap.set('web_fetch', webFetchDef.handler);

  return { apiTools, handlerMap };
}

/**
 * Get Anthropic's built-in web search tool config (server-side, no handler needed).
 * Only available for Anthropic models.
 */
export function getWebSearchTool(model: string): WebSearchToolDef | null {
  const provider = getProviderForModel(model);
  if (provider !== 'anthropic') return null;

  return {
    type: 'web_search_20250305',
    name: 'web_search',
  };
}

/**
 * Custom web_fetch tool — fetches a URL and returns its text content.
 */
function getWebFetchTool(): { definition: Tool; handler: (input: Record<string, unknown>) => Promise<string> } {
  const definition: Tool = {
    name: 'web_fetch',
    description: 'Fetch and read content from a URL. Returns the text content of the page with HTML tags stripped. Useful for reading articles, documentation, or any web page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        max_length: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000)',
        },
      },
      required: ['url'],
    },
  };

  const handler = async (input: Record<string, unknown>): Promise<string> => {
    const url = input.url as string;
    const maxLength = (input.max_length as number) || 10000;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PocketAgent/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      // If it's HTML, strip tags
      let content: string;
      if (contentType.includes('html')) {
        content = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      } else {
        content = text;
      }

      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + '\n\n[Content truncated]';
      }

      return content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error fetching ${url}: ${msg}`;
    }
  };

  return { definition, handler };
}
