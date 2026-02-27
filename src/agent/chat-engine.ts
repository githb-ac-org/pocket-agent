/**
 * Chat Engine — Lightweight agent loop for General mode
 *
 * Uses @anthropic-ai/sdk (Messages API) directly — in-process, minimal system prompt,
 * only relevant tools, full context control. No subprocess, no MCP, no Claude Code preset.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MemoryManager } from '../memory';
import { ToolsConfig, setCurrentSessionId, runWithSessionId } from '../tools';
import { SettingsManager } from '../settings';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { createChatClient, getProviderForModel } from './chat-providers';
import { getChatToolDefinitions, getWebSearchTool, ChatToolSet } from './chat-tools';
import type { AgentStatus, ImageContent, AttachmentInfo, ProcessResult, MediaAttachment } from './index';

// Anthropic API message types
type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;

// Thinking config (matches main agent, plus adaptive for 4.6 models)
type ThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }
  | { type: 'adaptive' };

const THINKING_CONFIGS: Record<string, { thinking: ThinkingConfig; temperature?: number }> = {
  'none':     { thinking: { type: 'disabled' } },
  'minimal':  { thinking: { type: 'enabled', budget_tokens: 2048 } },
  'normal':   { thinking: { type: 'enabled', budget_tokens: 10000 } },
  'extended': { thinking: { type: 'enabled', budget_tokens: 30000 } },
};

const MAX_TOOL_ITERATIONS = 20;
const MAX_CONTEXT_MESSAGES = 80; // Trim when conversation exceeds this

// Tool output truncation limits (safety net — per-tool limits fire first)
const TOOL_OUTPUT_MAX_CHARS = 30_000;
const TOOL_OUTPUT_MAX_LINES = 2000;

// Models that support adaptive thinking (skip thinking on simple queries)
const ADAPTIVE_THINKING_MODELS = new Set(['claude-opus-4-6', 'claude-sonnet-4-6']);

interface ChatEngineConfig {
  memory: MemoryManager;
  toolsConfig: ToolsConfig;
  statusEmitter: (status: AgentStatus) => void;
}

/**
 * In-process chat engine using Anthropic Messages API directly.
 */
export class ChatEngine {
  private memory: MemoryManager;
  private toolsConfig: ToolsConfig;
  private emitStatus: (status: AgentStatus) => void;
  private conversationsBySession: Map<string, MessageParam[]> = new Map();
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private messageQueueBySession: Map<string, Array<{
    message: string;
    channel: string;
    images?: ImageContent[];
    attachmentInfo?: AttachmentInfo;
    resolve: (result: ProcessResult) => void;
    reject: (error: Error) => void;
  }>> = new Map();
  private pendingMedia: MediaAttachment[] = [];

  constructor(config: ChatEngineConfig) {
    this.memory = config.memory;
    this.toolsConfig = config.toolsConfig;
    this.emitStatus = config.statusEmitter;

    // Wire up the summarizer for smart context / compaction
    this.memory.setSummarizer(async (messages) => {
      const currentModel = SettingsManager.get('agent.model') || 'claude-haiku-4-5-20251001';
      // Use haiku for summarization (fast + cheap), fall back to current model
      const summaryModel = 'claude-haiku-4-5-20251001';
      try {
        const client = await createChatClient(summaryModel);
        const prompt = messages.map(m => `[${m.role}]: ${m.content}`).join('\n');
        const result = await client.messages.create({
          model: summaryModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: `Summarize this conversation concisely, preserving key facts, decisions, and context:\n\n${prompt}` }],
        });
        return result.content.length > 0 && result.content[0].type === 'text' ? result.content[0].text : '';
      } catch (err) {
        console.error('[ChatEngine] Summarizer failed, falling back to current model:', err);
        // Fallback to current model if haiku fails
        const client = await createChatClient(currentModel);
        const prompt = messages.map(m => `[${m.role}]: ${m.content}`).join('\n');
        const result = await client.messages.create({
          model: currentModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: `Summarize this conversation concisely, preserving key facts, decisions, and context:\n\n${prompt}` }],
        });
        return result.content.length > 0 && result.content[0].type === 'text' ? result.content[0].text : '';
      }
    });
    console.log('[ChatEngine] Summarizer wired up');
  }

  /**
   * Process a user message through the Chat engine.
   */
  async processMessage(
    userMessage: string,
    channel: string,
    sessionId: string = 'default',
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    // Queue if already processing
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(userMessage, channel, sessionId, images, attachmentInfo);
    }
    return this.executeMessage(userMessage, channel, sessionId, images, attachmentInfo);
  }

  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;
      queue.push({ message: userMessage, channel, images, attachmentInfo, resolve, reject });

      this.emitStatus({
        type: 'queued',
        sessionId,
        queuePosition: queue.length,
        queuedMessage: userMessage.slice(0, 100),
        message: `in the litter queue (#${queue.length})`,
      });
    });
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.messageQueueBySession.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    this.emitStatus({
      type: 'queue_processing',
      sessionId,
      queuedMessage: next.message.slice(0, 100),
      message: 'digging it up now...',
    });

    try {
      const result = await this.executeMessage(next.message, next.channel, sessionId, next.images, next.attachmentInfo);
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Execute a message against the Anthropic Messages API with tool loop.
   */
  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    // Set session context so tool handlers (scheduler, calendar, tasks) use the correct session
    setCurrentSessionId(sessionId);
    return runWithSessionId(sessionId, () => this.executeMessageInner(userMessage, channel, sessionId, images, attachmentInfo));
  }

  private async executeMessageInner(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    this.processingBySession.set(sessionId, true);
    this.pendingMedia = [];

    const abortController = new AbortController();
    this.abortControllersBySession.set(sessionId, abortController);

    try {
      // Get or create conversation history
      if (!this.conversationsBySession.has(sessionId)) {
        await this.loadConversationFromMemory(sessionId);
      }
      const conversation = this.conversationsBySession.get(sessionId)!;

      // Build user message content with inline timestamp so the model always
      // sees the current time adjacent to the query (not just in the system prompt,
      // which can be overlooked in long conversations).
      const now = new Date();
      const timeTag = `[${now.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}]`;
      const timestampedMessage = `${timeTag} ${userMessage}`;
      const userContent = this.buildUserContent(timestampedMessage, images);
      conversation.push({ role: 'user', content: userContent });

      // Compact conversation if too long (uses smart context with rolling summaries)
      const wasCompacted = await this.compactConversation(sessionId, userMessage);

      // Build system prompt — split into static (cacheable) and dynamic (fresh per-turn)
      const { staticPrompt, dynamicPrompt } = this.buildSystemPrompt(sessionId);

      // Get model
      const model = SettingsManager.get('agent.model') || 'claude-opus-4-6';

      // Create client
      const client = await createChatClient(model);

      // Get tools
      const toolSet = getChatToolDefinitions(this.toolsConfig);
      const webSearch = getWebSearchTool(model);
      const allTools = [...toolSet.apiTools];
      if (webSearch) {
        allTools.push(webSearch);
      }

      // Get thinking config
      const provider = getProviderForModel(model);
      const isAnthropic = provider === 'anthropic';
      const thinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
      const thinkingEntry = THINKING_CONFIGS[thinkingLevel] || THINKING_CONFIGS['normal'];

      this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

      // Prompt caching: static block is cached, dynamic block (time, facts, soul) is never cached.
      // This prevents stale time from being served from the ~5min ephemeral cache.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const systemParam: any = isAnthropic
        ? [
            { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicPrompt },
          ]
        : `${staticPrompt}\n\n${dynamicPrompt}`;

      // Determine effective thinking mode for logging
      let effectiveThinking = 'disabled';
      if (isAnthropic && thinkingEntry.thinking.type !== 'disabled') {
        effectiveThinking = ADAPTIVE_THINKING_MODELS.has(model) && thinkingEntry.thinking.type === 'enabled'
          ? 'adaptive'
          : `budget:${(thinkingEntry.thinking as { budget_tokens: number }).budget_tokens}`;
      }
      console.log(`[ChatEngine] Session config — model: ${model}, thinking: ${effectiveThinking}, caching: ${isAnthropic ? 'on' : 'off'}`);

      // Agentic tool loop
      let response = '';
      let iterations = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;

        // Apply cache breakpoints to last user message (Anthropic only)
        if (isAnthropic) {
          this.applyCacheBreakpoints(conversation);
        }

        // Build request params
        const params: Anthropic.Messages.MessageCreateParams = {
          model,
          max_tokens: 16384,
          system: systemParam,
          messages: conversation,
          tools: allTools as Anthropic.Messages.MessageCreateParams['tools'],
        };

        // Add thinking for Anthropic models
        if (isAnthropic && thinkingEntry.thinking.type !== 'disabled') {
          // Use adaptive thinking for 4.6 models (lets model skip thinking on simple queries)
          if (ADAPTIVE_THINKING_MODELS.has(model) && thinkingEntry.thinking.type === 'enabled') {
            params.thinking = { type: 'adaptive' };
          } else {
            params.thinking = thinkingEntry.thinking;
          }
          params.temperature = 1; // Required when thinking is enabled
        }

        let result: Anthropic.Messages.Message;
        try {
          result = await client.messages.create(params, {
            signal: abortController.signal,
          });
        } finally {
          // Clean up cache markers to keep conversation state clean
          if (isAnthropic) {
            this.removeCacheBreakpoints(conversation);
          }
        }

        // Log per-turn token usage and cache stats
        const usage = result.usage;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cacheRead = (usage as any).cache_read_input_tokens || 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cacheCreation = (usage as any).cache_creation_input_tokens || 0;

        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheRead += cacheRead;
        totalCacheCreation += cacheCreation;

        const totalIn = inputTokens + cacheRead + cacheCreation;
        const cacheHitPct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
        console.log(`[ChatEngine] Turn ${iterations} — in: ${inputTokens}, out: ${outputTokens}, cache_read: ${cacheRead}, cache_create: ${cacheCreation}, cache_hit: ${cacheHitPct}%`);

        // Process response content blocks
        // Cast to generic array since API may return block types not in SDK typings
        // (e.g. server_tool_use, web_search_tool_result)
        const assistantContent: ContentBlockParam[] = [];
        let hasToolUse = false;
        const toolResults: ToolResultBlockParam[] = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const rawBlock of result.content as any[]) {
          const blockType = rawBlock.type as string;

          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            // Thinking block — skip (not added to conversation)
            continue;
          }

          if (blockType === 'text') {
            response += (response ? '\n\n' : '') + rawBlock.text;
            assistantContent.push({ type: 'text', text: rawBlock.text } as TextBlockParam);

            // Emit only this turn's text (UI accumulates across events)
            this.emitStatus({
              type: 'partial_text',
              sessionId,
              partialText: rawBlock.text,
              message: 'composing...',
            });
          } else if (blockType === 'tool_use') {
            hasToolUse = true;
            assistantContent.push(rawBlock as ContentBlockParam);

            const isShell = rawBlock.name === 'shell_command';
            this.emitStatus({
              type: 'tool_start',
              sessionId,
              toolName: rawBlock.name,
              toolInput: this.formatToolInput(rawBlock.input),
              message: isShell ? `running ${this.formatToolInput(rawBlock.input)}...` : `batting at ${rawBlock.name}...`,
              isPocketCli: isShell,
            });

            // Execute tool
            const toolResult = await this.executeTool(
              rawBlock.id,
              rawBlock.name,
              rawBlock.input as Record<string, unknown>,
              toolSet,
              sessionId
            );

            toolResults.push(toolResult);

            this.emitStatus({
              type: 'tool_end',
              sessionId,
              message: 'caught it! processing...',
            });
          } else if (blockType === 'server_tool_use') {
            // Server-side tool (web_search) — include in assistant content
            assistantContent.push(rawBlock as ContentBlockParam);
            this.emitStatus({
              type: 'tool_start',
              sessionId,
              toolName: 'web_search',
              message: 'prowling the web...',
            });
          } else if (blockType === 'web_search_tool_result') {
            // Web search result — stays in assistant content (server-side tool, not a user tool_result)
            assistantContent.push(rawBlock as ContentBlockParam);
            this.emitStatus({
              type: 'tool_end',
              sessionId,
              message: 'found some stuff!',
            });
          }
        }

        // Add assistant message to conversation
        conversation.push({ role: 'assistant', content: assistantContent });

        // If there were tool uses, add results and continue loop
        if (hasToolUse || toolResults.length > 0) {
          conversation.push({ role: 'user', content: toolResults as ContentBlockParam[] });
          continue;
        }

        // No tool use — we're done (end_turn)
        break;
      }

      // Log completion summary
      const totalTokens = totalInputTokens + totalOutputTokens;
      const overallTotalIn = totalInputTokens + totalCacheRead + totalCacheCreation;
      const overallCacheHit = overallTotalIn > 0 ? Math.round((totalCacheRead / overallTotalIn) * 100) : 0;
      console.log(`[ChatEngine] Done — ${iterations} turn(s), ${totalTokens} total tokens (in: ${totalInputTokens}, out: ${totalOutputTokens}), cache_hit: ${overallCacheHit}%, cache_read: ${totalCacheRead}, cache_create: ${totalCacheCreation}`);

      this.emitStatus({ type: 'done', sessionId });

      if (!response) {
        response = 'Task completed (no details available).';
      }

      // Save to memory (same DB as Coder mode)
      const isScheduledJob = channel.startsWith('cron:');
      const isHeartbeat = response.toUpperCase().includes('HEARTBEAT_OK');

      if (!(isScheduledJob && isHeartbeat)) {
        let messageToSave = userMessage;

        // Strip heartbeat suffix
        const heartbeatSuffix = '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';
        if (messageToSave.endsWith(heartbeatSuffix)) {
          messageToSave = messageToSave.slice(0, -heartbeatSuffix.length);
        }

        // Convert reminder prompts
        const reminderMatch = messageToSave.match(/^\[SCHEDULED REMINDER - DELIVER NOW\]\nThe user previously asked to be reminded about: "(.+?)"\n\nDeliver this reminder/);
        if (reminderMatch) {
          messageToSave = `Reminder: ${reminderMatch[1]}`;
        }

        // Build metadata
        let metadata: Record<string, unknown> | undefined;
        if (channel.startsWith('cron:')) {
          metadata = { source: 'scheduler', jobName: channel.slice(5) };
        } else if (channel === 'telegram') {
          const hasAttachment = attachmentInfo?.hasAttachment ?? (images && images.length > 0);
          const attachmentType = attachmentInfo?.attachmentType ?? (images && images.length > 0 ? 'photo' : undefined);
          metadata = { source: 'telegram', hasAttachment, attachmentType };
        } else if (channel === 'ios') {
          metadata = { source: 'ios' };
        }

        const userMsgId = this.memory.saveMessage('user', messageToSave, sessionId, metadata);
        const assistantMetadata = metadata ? { source: metadata.source } : undefined;
        const assistantMsgId = this.memory.saveMessage('assistant', response, sessionId, assistantMetadata);

        // Embed asynchronously
        this.memory.embedMessage(userMsgId).catch(e => console.error('[ChatEngine] Failed to embed user message:', e));
        this.memory.embedMessage(assistantMsgId).catch(e => console.error('[ChatEngine] Failed to embed assistant message:', e));
      }

      return {
        response,
        tokensUsed: totalInputTokens + totalOutputTokens,
        wasCompacted,
        media: this.pendingMedia.length > 0 ? this.pendingMedia : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('aborted') || errorMsg.includes('interrupted')) {
        this.emitStatus({ type: 'done', sessionId });
        return { response: '', tokensUsed: 0, wasCompacted: false };
      }

      console.error('[ChatEngine] Query failed:', errorMsg);

      // Save error to memory
      this.memory.saveMessage('user', userMessage, sessionId);
      this.memory.saveMessage('assistant', errorMsg, sessionId, { isError: true });

      throw error;
    } finally {
      this.processingBySession.set(sessionId, false);
      this.abortControllersBySession.delete(sessionId);

      setTimeout(() => {
        this.processQueue(sessionId).catch((err) => {
          console.error('[ChatEngine] Queue processing failed:', err);
        });
      }, 0);
    }
  }

  /**
   * Execute a tool by name and return a tool_result block.
   */
  private async executeTool(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolSet: ChatToolSet,
    _sessionId: string
  ): Promise<ToolResultBlockParam> {
    const handler = toolSet.handlerMap.get(toolName);
    if (!handler) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Unknown tool: ${toolName}`,
        is_error: true,
      };
    }

    try {
      const rawResult = await handler(input);
      const result = this.truncateToolOutput(toolName, rawResult);
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Tool error: ${msg}`,
        is_error: true,
      };
    }
  }

  /**
   * Add cache_control breakpoint to the last real user message (skipping tool_result messages).
   * This makes the conversation prefix cacheable across turns.
   */
  private applyCacheBreakpoints(conversation: MessageParam[]): void {
    // Walk backwards to find the last user message with text content (not tool_result)
    for (let i = conversation.length - 1; i >= 0; i--) {
      const msg = conversation[i];
      if (msg.role !== 'user') continue;

      const content = msg.content;

      // String content — it's a real user message
      if (typeof content === 'string') {
        // Convert to array format so we can add cache_control
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (msg as any).content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
        return;
      }

      // Array content — check if it has text blocks (not just tool_result)
      if (Array.isArray(content)) {
        const hasText = content.some((b: ContentBlockParam) => b.type === 'text');
        if (!hasText) continue; // tool_result-only message, keep looking

        // Add cache_control to the last text block
        for (let j = content.length - 1; j >= 0; j--) {
          if (content[j].type === 'text') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (content[j] as any).cache_control = { type: 'ephemeral' };
            return;
          }
        }
      }
    }
  }

  /**
   * Remove cache_control markers from conversation after API call.
   */
  private removeCacheBreakpoints(conversation: MessageParam[]): void {
    for (const msg of conversation) {
      if (msg.role !== 'user') continue;

      const content = msg.content;

      // Check if we converted a string to array format
      if (Array.isArray(content) && content.length === 1 && content[0].type === 'text') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const block = content[0] as any;
        if (block.cache_control) {
          delete block.cache_control;
          // Convert back to string format for cleanliness
          msg.content = block.text;
          continue;
        }
      }

      // Array content — just remove cache_control from text blocks
      if (Array.isArray(content)) {
        for (const block of content) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((block as any).cache_control) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (block as any).cache_control;
          }
        }
      }
    }
  }

  /**
   * Truncate tool output to prevent context bloat.
   * Per-tool limits (web_fetch 10K, shell_command 50K) fire first; this is a safety net.
   */
  private truncateToolOutput(toolName: string, output: string): string {
    let truncated = output;
    let wasTruncated = false;

    // Line limit
    const lines = truncated.split('\n');
    if (lines.length > TOOL_OUTPUT_MAX_LINES) {
      truncated = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join('\n');
      wasTruncated = true;
    }

    // Character limit
    if (truncated.length > TOOL_OUTPUT_MAX_CHARS) {
      truncated = truncated.slice(0, TOOL_OUTPUT_MAX_CHARS);
      wasTruncated = true;
    }

    if (wasTruncated) {
      const notice = `\n\n[Output truncated — original was ${output.length.toLocaleString()} chars / ${lines.length.toLocaleString()} lines]`;
      truncated += notice;
      console.log(`[ChatEngine] Truncated ${toolName} output: ${output.length} chars / ${lines.length} lines → ${truncated.length} chars`);
    }

    return truncated;
  }

  /**
   * Build user content with optional images.
   */
  private buildUserContent(
    message: string,
    images?: ImageContent[]
  ): string | ContentBlockParam[] {
    if (!images || images.length === 0) {
      return message;
    }

    const content: ContentBlockParam[] = [
      { type: 'text', text: message } as TextBlockParam,
    ];

    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data,
        },
      } as ContentBlockParam);
    }

    return content;
  }

  /**
   * Build system prompt split into static (cacheable) and dynamic (per-turn) parts.
   *
   * Static: identity, instructions, profile, capabilities — rarely change.
   * Dynamic: temporal, facts, soul, daily logs — change every turn.
   *
   * Prompt caching caches the system prompt for ~5 minutes. If temporal context
   * is inside the cached block, the model sees stale time in long conversations.
   * Splitting ensures the model always gets fresh dynamic context.
   */
  private buildSystemPrompt(sessionId?: string): { staticPrompt: string; dynamicPrompt: string } {
    // === Static context (cached) ===
    const staticParts: string[] = [];

    const identity = loadIdentity();
    if (identity) {
      staticParts.push(identity);
    }

    const instructions = loadInstructions();
    if (instructions) {
      staticParts.push(instructions);
    }

    const profile = SettingsManager.getFormattedProfile();
    if (profile) {
      staticParts.push(profile);
    }

    staticParts.push(this.buildCapabilitiesPrompt());

    // === Dynamic context (never cached) ===
    const dynamicParts: string[] = [];

    const lastUserMsg = sessionId ? this.getLastUserMessageTimestamp(sessionId) : undefined;
    dynamicParts.push(this.buildTemporalContext(lastUserMsg));

    const facts = this.memory.getFactsForContext();
    if (facts) {
      dynamicParts.push(facts);
    }

    const soul = this.memory.getSoulContext();
    if (soul) {
      dynamicParts.push(soul);
    }

    const dailyLogs = this.memory.getDailyLogsContext(3);
    if (dailyLogs) {
      dynamicParts.push(dailyLogs);
    }

    return {
      staticPrompt: staticParts.join('\n\n'),
      dynamicPrompt: dynamicParts.join('\n\n'),
    };
  }

  private getLastUserMessageTimestamp(sessionId: string): string | undefined {
    try {
      const messages = this.memory.getRecentMessages(1, sessionId);
      if (messages.length > 0) {
        return messages[0].timestamp;
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  private parseDbTimestamp(timestamp: string): Date {
    // If already has timezone indicator, parse directly
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    // Check if user has configured a timezone
    const userTimezone = SettingsManager.get('profile.timezone');

    if (userTimezone) {
      // User has timezone set - treat DB timestamps as UTC
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized + 'Z');
    } else {
      // No timezone configured - use system local time
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized);
    }
  }

  private buildTemporalContext(lastMessageTimestamp?: string): string {
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[now.getDay()];

    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const dateStr = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    const lines = [
      '## Current Time',
      `It is ${dayName}, ${dateStr} at ${timeStr}.`,
    ];

    // Add time since last message if available
    if (lastMessageTimestamp) {
      try {
        const lastDate = this.parseDbTimestamp(lastMessageTimestamp);
        const diffMs = now.getTime() - lastDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let timeSince = '';
        if (diffMins < 1) timeSince = 'just now';
        else if (diffMins < 60) timeSince = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        else if (diffHours < 24) timeSince = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        else if (diffDays < 7) timeSince = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        else timeSince = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        lines.push(`Last message from user was ${timeSince}.`);
      } catch {
        // Ignore timestamp parsing errors
      }
    }

    return lines.join('\n');
  }

  private buildCapabilitiesPrompt(): string {
    return `## Your Capabilities

You are a persistent personal AI assistant with these tools available:

### Memory & Facts
- remember: Save a fact (category, key, value)
- forget: Delete a fact
- list_facts: List all facts or by category
- memory_search: Search facts by keyword

### Scheduling & Reminders
- schedule_task: Create reminders with one-time, interval, or cron schedules
- create_reminder: Quick reminder shortcut
- list_scheduled_tasks: See all scheduled tasks
- delete_scheduled_task: Remove a task

### Calendar & Tasks
- calendar_add, calendar_list, calendar_upcoming, calendar_delete
- task_add, task_list, task_complete, task_delete, task_due

### Browser Automation
- browser: Navigate, screenshot, click, type, evaluate, extract, scroll, download

### Shell Commands
- shell_command: Execute shell commands (bash/PowerShell) for file operations, git, scripts, system tasks

### Web Access
- web_search: Search the web for current information
- web_fetch: Fetch and read content from URLs

### Notifications
- notify: Send native desktop notifications

### Important
- Save facts PROACTIVELY when user mentions personal info, preferences, projects, people, or work details
- Categories: user_info, preferences, projects, people, work, notes, decisions`;
  }

  /**
   * Load conversation history from SQLite into in-memory format.
   * Uses smart context (rolling summary + recent messages) for longer sessions.
   */
  async loadConversationFromMemory(sessionId: string): Promise<void> {
    const messageCount = this.memory.getSessionMessageCount(sessionId);

    // For short sessions, just load directly
    if (messageCount <= MAX_CONTEXT_MESSAGES) {
      const messages = this.memory.getRecentMessages(MAX_CONTEXT_MESSAGES, sessionId);
      const conversation: MessageParam[] = [];

      for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          conversation.push({ role: msg.role, content: msg.content });
        }
      }

      // Clean: ensure starts with user, merge consecutive same-role
      const cleaned = this.cleanConversation(conversation);
      this.conversationsBySession.set(sessionId, cleaned);
      console.log(`[ChatEngine] Loaded ${cleaned.length} messages for session ${sessionId}`);
      return;
    }

    // For longer sessions, use smart context with rolling summaries
    try {
      const smartContext = await this.memory.getSmartContext(sessionId, {
        recentMessageLimit: 40,
        rollingSummaryInterval: 30,
        semanticRetrievalCount: 0, // no query yet
      });

      const conversation: MessageParam[] = [];

      if (smartContext.rollingSummary) {
        conversation.push({ role: 'user', content: '[System: Previous conversation summary]' });
        conversation.push({ role: 'assistant', content: smartContext.rollingSummary });
      }

      for (const msg of smartContext.recentMessages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          conversation.push({ role: msg.role, content: msg.content });
        }
      }

      const cleaned = this.cleanConversation(conversation);
      this.conversationsBySession.set(sessionId, cleaned);
      console.log(`[ChatEngine] Loaded ${cleaned.length} messages with smart context for session ${sessionId} (summary: ${smartContext.rollingSummary ? 'yes' : 'no'})`);
    } catch (err) {
      console.error('[ChatEngine] Smart context load failed, falling back to recent messages:', err);
      // Fallback to simple load
      const messages = this.memory.getRecentMessages(MAX_CONTEXT_MESSAGES, sessionId);
      const conversation: MessageParam[] = [];
      for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          conversation.push({ role: msg.role, content: msg.content });
        }
      }
      const cleaned = this.cleanConversation(conversation);
      this.conversationsBySession.set(sessionId, cleaned);
      console.log(`[ChatEngine] Fallback loaded ${cleaned.length} messages for session ${sessionId}`);
    }
  }

  /**
   * Clean conversation: ensure starts with user message, merge consecutive same-role messages.
   */
  private cleanConversation(conversation: MessageParam[]): MessageParam[] {
    // Ensure starts with user message
    while (conversation.length > 0 && conversation[0].role !== 'user') {
      conversation.shift();
    }

    // Merge consecutive same-role messages
    const cleaned: MessageParam[] = [];
    for (const msg of conversation) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === msg.role) {
        const prev = cleaned[cleaned.length - 1];
        const prevText = typeof prev.content === 'string' ? prev.content : '';
        const curText = typeof msg.content === 'string' ? msg.content : '';
        prev.content = prevText + '\n\n' + curText;
      } else {
        cleaned.push({ ...msg });
      }
    }

    return cleaned;
  }

  /**
   * Compact conversation using smart context (rolling summary + recent messages).
   * Replaces naive truncation with summarization-aware compaction.
   */
  private async compactConversation(sessionId: string, currentQuery: string): Promise<boolean> {
    const conversation = this.conversationsBySession.get(sessionId);
    if (!conversation || conversation.length <= MAX_CONTEXT_MESSAGES) return false;

    try {
      // Use getSmartContext to get rolling summary + recent messages
      const smartContext = await this.memory.getSmartContext(sessionId, {
        recentMessageLimit: 40,
        rollingSummaryInterval: 30,
        semanticRetrievalCount: 5,
        currentQuery,
      });

      // Rebuild in-memory conversation from smart context
      const newConversation: MessageParam[] = [];

      // Prepend rolling summary as first context
      if (smartContext.rollingSummary) {
        newConversation.push({ role: 'user', content: '[System: Previous conversation summary]' });
        newConversation.push({ role: 'assistant', content: smartContext.rollingSummary });
      }

      // Add recent messages
      for (const msg of smartContext.recentMessages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          newConversation.push({ role: msg.role, content: msg.content });
        }
      }

      // Ensure starts with user message
      while (newConversation.length > 0 && newConversation[0].role !== 'user') {
        newConversation.shift();
      }

      this.conversationsBySession.set(sessionId, newConversation);
      console.log(`[ChatEngine] Compacted: ${conversation.length} -> ${newConversation.length} messages (summary: ${smartContext.rollingSummary ? 'yes' : 'no'})`);
      return true;
    } catch (err) {
      console.error('[ChatEngine] Compaction failed, falling back to naive trim:', err);
      // Fallback: naive trim
      const trimTo = Math.floor(MAX_CONTEXT_MESSAGES * 0.75);
      const trimmed = conversation.slice(-trimTo);
      while (trimmed.length > 0 && trimmed[0].role !== 'user') {
        trimmed.shift();
      }
      this.conversationsBySession.set(sessionId, trimmed);
      return false;
    }
  }

  /**
   * Stop a running query for a session.
   */
  stopQuery(sessionId?: string): boolean {
    if (sessionId) {
      // Clear queue
      const queue = this.messageQueueBySession.get(sessionId);
      if (queue) {
        for (const item of queue) {
          item.reject(new Error('Queue cleared'));
        }
        this.messageQueueBySession.delete(sessionId);
      }

      const controller = this.abortControllersBySession.get(sessionId);
      if (controller && this.processingBySession.get(sessionId)) {
        controller.abort();
        return true;
      }
      return false;
    }

    // Stop any running query
    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        const controller = this.abortControllersBySession.get(sid);
        if (controller) {
          controller.abort();
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a query is processing.
   */
  isQueryProcessing(sessionId?: string): boolean {
    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    for (const v of this.processingBySession.values()) {
      if (v) return true;
    }
    return false;
  }

  /**
   * Clear conversation history for a session.
   */
  clearSession(sessionId: string): void {
    this.conversationsBySession.delete(sessionId);
  }

  private formatToolInput(input: unknown): string {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 100);
    const inp = input as Record<string, string | undefined>;
    return (inp.query || inp.url || inp.category || inp.content || inp.action || '').slice(0, 80);
  }
}
