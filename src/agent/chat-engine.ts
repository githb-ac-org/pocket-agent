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

// Thinking config (matches main agent)
type ThinkingConfig = { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };

const THINKING_CONFIGS: Record<string, { thinking: ThinkingConfig; temperature?: number }> = {
  'none':     { thinking: { type: 'disabled' } },
  'minimal':  { thinking: { type: 'enabled', budget_tokens: 2048 } },
  'normal':   { thinking: { type: 'enabled', budget_tokens: 10000 } },
  'extended': { thinking: { type: 'enabled', budget_tokens: 30000 } },
};

const MAX_TOOL_ITERATIONS = 20;
const MAX_CONTEXT_MESSAGES = 80; // Trim when conversation exceeds this

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
        return result.content[0].type === 'text' ? result.content[0].text : '';
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
        return result.content[0].type === 'text' ? result.content[0].text : '';
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

      // Build user message content
      const userContent = this.buildUserContent(userMessage, images);
      conversation.push({ role: 'user', content: userContent });

      // Compact conversation if too long (uses smart context with rolling summaries)
      const wasCompacted = await this.compactConversation(sessionId, userMessage);

      // Build system prompt (pass sessionId for temporal context)
      const systemPrompt = this.buildSystemPrompt(sessionId);

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

      // Agentic tool loop
      let response = '';
      let iterations = 0;

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;

        // Build request params
        const params: Anthropic.Messages.MessageCreateParams = {
          model,
          max_tokens: 16384,
          system: systemPrompt,
          messages: conversation,
          tools: allTools as Anthropic.Messages.MessageCreateParams['tools'],
        };

        // Add thinking for Anthropic models
        if (isAnthropic && thinkingEntry.thinking.type === 'enabled') {
          params.thinking = thinkingEntry.thinking;
          params.temperature = 1; // Required when thinking is enabled
        }

        const result = await client.messages.create(params, {
          signal: abortController.signal,
        });

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
            // Web search result — include in tool results
            toolResults.push(rawBlock as ToolResultBlockParam);
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
        tokensUsed: 0,
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
      const result = await handler(input);
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
   * Build system prompt from identity, instructions, profile, facts, soul, temporal.
   */
  private buildSystemPrompt(sessionId?: string): string {
    const parts: string[] = [];

    // Identity
    const identity = loadIdentity();
    if (identity) {
      parts.push(identity);
    }

    // Instructions
    const instructions = loadInstructions();
    if (instructions) {
      parts.push(instructions);
    }

    // User profile
    const profile = SettingsManager.getFormattedProfile();
    if (profile) {
      parts.push(profile);
    }

    // Temporal context (with last message awareness)
    const lastUserMsg = sessionId ? this.getLastUserMessageTimestamp(sessionId) : undefined;
    parts.push(this.buildTemporalContext(lastUserMsg));

    // Facts
    const facts = this.memory.getFactsForContext();
    if (facts) {
      parts.push(facts);
    }

    // Soul
    const soul = this.memory.getSoulContext();
    if (soul) {
      parts.push(soul);
    }

    // Daily logs
    const dailyLogs = this.memory.getDailyLogsContext(3);
    if (dailyLogs) {
      parts.push(dailyLogs);
    }

    // Capabilities (simplified for chat mode)
    parts.push(this.buildCapabilitiesPrompt());

    return parts.join('\n\n');
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
   * Stop all running queries across all sessions.
   */
  stopAllQueries(): void {
    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        const controller = this.abortControllersBySession.get(sid);
        if (controller) {
          console.log(`[ChatEngine] Stopping query for session ${sid}`);
          controller.abort();
        }
      }
    }
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
