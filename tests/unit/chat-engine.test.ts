/**
 * Unit tests for ChatEngine performance optimizations:
 * - Prompt caching (Anthropic only)
 * - Adaptive thinking (4.6 models)
 * - Tool output truncation
 * - Performance logging / token tracking
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

vi.mock('../../src/settings', () => ({
  SettingsManager: {
    get: vi.fn((key: string) => {
      if (key === 'agent.model') return 'claude-opus-4-6';
      if (key === 'agent.thinkingLevel') return 'normal';
      return undefined;
    }),
    getFormattedProfile: vi.fn(() => ''),
  },
}));

vi.mock('../../src/memory', () => ({
  MemoryManager: vi.fn(),
}));

vi.mock('../../src/config/identity', () => ({
  loadIdentity: vi.fn(() => 'Test identity'),
}));

vi.mock('../../src/config/instructions', () => ({
  loadInstructions: vi.fn(() => 'Test instructions'),
}));

vi.mock('../../src/agent/chat-providers', () => ({
  createChatClient: vi.fn(async () => ({
    messages: { create: mockCreate },
  })),
  getProviderForModel: vi.fn((model: string) => {
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('kimi-')) return 'moonshot';
    return 'anthropic';
  }),
}));

vi.mock('../../src/agent/chat-tools', () => ({
  getChatToolDefinitions: vi.fn(() => ({
    apiTools: [],
    handlerMap: new Map([
      ['test_tool', async () => 'tool result'],
      ['big_tool', async () => 'x'.repeat(50_000)],
      ['many_lines_tool', async () => Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')],
    ]),
  })),
  getWebSearchTool: vi.fn(() => null),
}));

vi.mock('../../src/tools', () => ({
  setCurrentSessionId: vi.fn(),
  runWithSessionId: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

import { ChatEngine } from '../../src/agent/chat-engine';
import { SettingsManager } from '../../src/settings';
import { getProviderForModel } from '../../src/agent/chat-providers';

// ── Helpers ────────────────────────────────────────────────────────────

function makeApiResponse(text: string, usage?: Record<string, number>) {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
    stop_reason: 'end_turn',
  };
}

function createEngine() {
  const memory = {
    setSummarizer: vi.fn(),
    getRecentMessages: vi.fn(() => []),
    getSessionMessageCount: vi.fn(() => 0),
    getFactsForContext: vi.fn(() => ''),
    getSoulContext: vi.fn(() => ''),
    getDailyLogsContext: vi.fn(() => ''),
    saveMessage: vi.fn(() => 1),
    embedMessage: vi.fn(async () => {}),
    getSmartContext: vi.fn(async () => ({ recentMessages: [], rollingSummary: null })),
  };

  const statusEmitter = vi.fn();

  const engine = new ChatEngine({
    memory: memory as any,
    toolsConfig: {} as any,
    statusEmitter,
  });

  return { engine, memory, statusEmitter };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ChatEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    // Reset default mock implementations
    vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
      if (key === 'agent.model') return 'claude-opus-4-6';
      if (key === 'agent.thinkingLevel') return 'normal';
      return undefined;
    });
    vi.mocked(getProviderForModel).mockImplementation((model: string) => {
      if (model.startsWith('claude-')) return 'anthropic' as any;
      if (model.startsWith('kimi-')) return 'moonshot' as any;
      return 'anthropic' as any;
    });
  });

  // ─── Prompt Caching ─────────────────────────────────────────────────

  describe('Prompt caching', () => {
    it('uses array system prompt with cache_control for Anthropic models', async () => {
      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      // System should be array with cache_control
      expect(Array.isArray(callArgs.system)).toBe(true);
      expect(callArgs.system[0].type).toBe('text');
      expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('uses plain string system prompt for non-Anthropic models', async () => {
      vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
        if (key === 'agent.model') return 'kimi-k2.5';
        if (key === 'agent.thinkingLevel') return 'normal';
        return undefined;
      });
      vi.mocked(getProviderForModel).mockReturnValue('moonshot' as any);

      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      // System should be a plain string
      expect(typeof callArgs.system).toBe('string');
    });

    it('adds cache_control to last user message for Anthropic', async () => {
      // Capture a snapshot of the messages at API call time (before cleanup removes cache_control)
      let capturedLastUserContent: any = null;
      mockCreate.mockImplementationOnce((params: any) => {
        const userMsgs = params.messages.filter((m: any) => m.role === 'user');
        const last = userMsgs[userMsgs.length - 1];
        // Deep clone to capture state before removeCacheBreakpoints mutates it
        capturedLastUserContent = JSON.parse(JSON.stringify(last.content));
        return Promise.resolve(makeApiResponse('Hello'));
      });

      const { engine } = createEngine();
      await engine.processMessage('hi', 'desktop', 'test-session');

      // The content should have been converted to array with cache_control
      expect(Array.isArray(capturedLastUserContent)).toBe(true);
      expect(capturedLastUserContent[0].type).toBe('text');
      expect(capturedLastUserContent[0].text).toBe('hi');
      expect(capturedLastUserContent[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('cleans up cache_control markers after API call', async () => {
      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      // Access the internal conversation to verify cleanup
      // The engine should have cleaned up the markers
      // We can verify by sending a second message and checking the first user message is clean
      mockCreate.mockResolvedValueOnce(makeApiResponse('World'));
      await engine.processMessage('follow up', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[1][0];
      const messages = callArgs.messages;

      // First user message (from previous turn) should not have cache_control
      // Only the last user message should have it
      const firstUserMsg = messages[0];
      if (typeof firstUserMsg.content === 'string') {
        // Clean — it was reverted to string
        expect(firstUserMsg.content).toBe('hi');
      } else if (Array.isArray(firstUserMsg.content)) {
        // If still array, it shouldn't have cache_control
        for (const block of firstUserMsg.content) {
          expect((block as any).cache_control).toBeUndefined();
        }
      }
    });
  });

  // ─── Adaptive Thinking ──────────────────────────────────────────────

  describe('Adaptive thinking', () => {
    it('uses adaptive thinking for claude-opus-4-6', async () => {
      vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
        if (key === 'agent.model') return 'claude-opus-4-6';
        if (key === 'agent.thinkingLevel') return 'normal';
        return undefined;
      });
      vi.mocked(getProviderForModel).mockReturnValue('anthropic' as any);

      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.temperature).toBe(1);
    });

    it('uses adaptive thinking for claude-sonnet-4-6', async () => {
      vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
        if (key === 'agent.model') return 'claude-sonnet-4-6';
        if (key === 'agent.thinkingLevel') return 'normal';
        return undefined;
      });
      vi.mocked(getProviderForModel).mockReturnValue('anthropic' as any);

      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
    });

    it('uses budget-based thinking for haiku', async () => {
      vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
        if (key === 'agent.model') return 'claude-haiku-4-5-20251001';
        if (key === 'agent.thinkingLevel') return 'normal';
        return undefined;
      });
      vi.mocked(getProviderForModel).mockReturnValue('anthropic' as any);

      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    });

    it('disables thinking when level is none', async () => {
      vi.mocked(SettingsManager.get).mockImplementation((key: string) => {
        if (key === 'agent.model') return 'claude-opus-4-6';
        if (key === 'agent.thinkingLevel') return 'none';
        return undefined;
      });
      vi.mocked(getProviderForModel).mockReturnValue('anthropic' as any);

      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.temperature).toBeUndefined();
    });
  });

  // ─── Tool Output Truncation ─────────────────────────────────────────

  describe('Tool output truncation', () => {
    it('truncates output exceeding 30K chars', async () => {
      // First call returns a tool_use, second returns text
      mockCreate
        .mockResolvedValueOnce({
          content: [{
            type: 'tool_use',
            id: 'tool_1',
            name: 'big_tool',
            input: {},
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce(makeApiResponse('Done'));

      const { engine } = createEngine();
      await engine.processMessage('run big tool', 'desktop', 'test-session');

      // The second call should have the tool result in messages
      const secondCall = mockCreate.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      expect(toolResultMsg).toBeDefined();

      const toolResult = toolResultMsg.content[0];
      // Original was 50K chars, should be truncated to ~30K + notice
      expect(toolResult.content.length).toBeLessThan(50_000);
      expect(toolResult.content).toContain('[Output truncated');
    });

    it('truncates output exceeding 2000 lines', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{
            type: 'tool_use',
            id: 'tool_2',
            name: 'many_lines_tool',
            input: {},
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce(makeApiResponse('Done'));

      const { engine } = createEngine();
      await engine.processMessage('run line tool', 'desktop', 'test-session');

      const secondCall = mockCreate.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      const toolResult = toolResultMsg.content[0];
      expect(toolResult.content).toContain('[Output truncated');
      expect(toolResult.content).toContain('3,000 lines');
    });

    it('does not truncate output within limits', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{
            type: 'tool_use',
            id: 'tool_3',
            name: 'test_tool',
            input: {},
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce(makeApiResponse('Done'));

      const { engine } = createEngine();
      await engine.processMessage('run small tool', 'desktop', 'test-session');

      const secondCall = mockCreate.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      const toolResult = toolResultMsg.content[0];
      expect(toolResult.content).toBe('tool result');
      expect(toolResult.content).not.toContain('[Output truncated');
    });
  });

  // ─── Performance Logging / Token Tracking ───────────────────────────

  describe('Performance logging', () => {
    it('logs session config at start', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      mockCreate.mockResolvedValueOnce(makeApiResponse('Hello'));
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const configLog = consoleSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('Session config')
      );
      expect(configLog).toBeDefined();
      expect(configLog![0]).toContain('thinking: adaptive');
      expect(configLog![0]).toContain('caching: on');

      consoleSpy.mockRestore();
    });

    it('logs per-turn cache stats', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      mockCreate.mockResolvedValueOnce(
        makeApiResponse('Hello', {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 50,
        })
      );
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const turnLog = consoleSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('Turn 1')
      );
      expect(turnLog).toBeDefined();
      expect(turnLog![0]).toContain('cache_read: 400');
      // cache_hit = 400 / (500 + 400 + 50) = 42%
      expect(turnLog![0]).toContain('cache_hit: 42%');

      consoleSpy.mockRestore();
    });

    it('logs completion summary', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      mockCreate.mockResolvedValueOnce(
        makeApiResponse('Hello', { input_tokens: 200, output_tokens: 50 })
      );
      const { engine } = createEngine();

      await engine.processMessage('hi', 'desktop', 'test-session');

      const summaryLog = consoleSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('[ChatEngine] Done')
      );
      expect(summaryLog).toBeDefined();
      expect(summaryLog![0]).toContain('250 total tokens');

      consoleSpy.mockRestore();
    });

    it('returns actual tokensUsed from API response', async () => {
      mockCreate.mockResolvedValueOnce(
        makeApiResponse('Hello', { input_tokens: 300, output_tokens: 75 })
      );
      const { engine } = createEngine();

      const result = await engine.processMessage('hi', 'desktop', 'test-session');
      expect(result.tokensUsed).toBe(375);
    });

    it('accumulates tokens across multiple tool iterations', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{
            type: 'tool_use',
            id: 'tool_1',
            name: 'test_tool',
            input: {},
          }],
          usage: { input_tokens: 200, output_tokens: 30 },
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce(
          makeApiResponse('Done', { input_tokens: 400, output_tokens: 60 })
        );

      const { engine } = createEngine();
      const result = await engine.processMessage('use tool', 'desktop', 'test-session');

      // 200 + 30 + 400 + 60 = 690
      expect(result.tokensUsed).toBe(690);
    });
  });
});
