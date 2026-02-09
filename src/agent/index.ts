import { MemoryManager, Message } from '../memory';
import { buildMCPServers, buildSdkMcpServers, setMemoryManager, setSoulMemoryManager, ToolsConfig, validateToolsConfig, runWithSessionId, getCurrentSessionId } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';
import path from 'path';
import { buildCanUseToolCallback, buildPreToolUseHook, setStatusEmitter } from './safety';

// Provider configuration for different LLM backends
type ProviderType = 'anthropic' | 'moonshot' | 'glm';

interface ProviderConfig {
  baseUrl?: string;
}

const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
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
const MODEL_PROVIDERS: Record<string, ProviderType> = {
  // Anthropic models
  'claude-opus-4-6': 'anthropic',
  'claude-opus-4-5-20251101': 'anthropic',
  'claude-sonnet-4-5-20250929': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  // Moonshot/Kimi models
  'kimi-k2.5': 'moonshot',
  // Z.AI GLM models
  'glm-4.7': 'glm',
};

/**
 * Get the provider type for a model
 */
function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}

/**
 * Configure environment variables for the selected provider
 * This is called before each SDK query to ensure correct routing
 */
function configureProviderEnvironment(model: string): void {
  const provider = getProviderForModel(model);
  const config = PROVIDER_CONFIGS[provider];

  // Clear all provider-related env vars first
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Note: ANTHROPIC_API_KEY may be set by OAuth or settings, don't clear if using Anthropic

  if (provider === 'moonshot') {
    // Moonshot requires base URL and uses Bearer token auth
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    // Clear ANTHROPIC_API_KEY so SDK uses AUTH_TOKEN instead
    delete process.env.ANTHROPIC_API_KEY;

    console.log('[AgentManager] Provider configured: Moonshot (Kimi)');
  } else if (provider === 'glm') {
    // Z.AI GLM requires base URL and uses Bearer token auth
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = glmKey;
    // Clear ANTHROPIC_API_KEY so SDK uses AUTH_TOKEN instead
    delete process.env.ANTHROPIC_API_KEY;

    console.log('[AgentManager] Provider configured: Z.AI GLM');
  } else {
    // Anthropic provider - ensure no base URL override
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    console.log('[AgentManager] Provider configured: Anthropic');
  }
}

// Status event types
export type AgentStatus = {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'tool_blocked' | 'responding' | 'done' | 'subagent_start' | 'subagent_update' | 'subagent_end' | 'queued' | 'queue_processing' | 'teammate_start' | 'teammate_idle' | 'teammate_message' | 'task_completed' | 'background_task_start' | 'background_task_output';
  sessionId?: string;
  toolName?: string;
  toolInput?: string;
  message?: string;
  // Subagent tracking
  agentId?: string;
  agentType?: string;
  agentCount?: number;  // Number of active subagents
  // Queue tracking
  queuePosition?: number;
  queuedMessage?: string;
  // Safety blocking
  blockedReason?: string;
  // Pocket CLI indicator
  isPocketCli?: boolean;
  // Team tracking
  teammateName?: string;
  teamName?: string;
  taskId?: string;
  taskSubject?: string;
  // Background task tracking
  backgroundTaskId?: string;
  backgroundTaskDescription?: string;
  backgroundTaskCount?: number;
};

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }>;
type PreToolUseHookCallback = (input: { tool_name: string; tool_input: unknown }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}>;
// Hook callback types for team events
type TeammateIdleHookCallback = (input: { teammate_name: string; team_name: string }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TeammateIdle';
  };
}>;
type TaskCompletedHookCallback = (input: { task_id: string; task_subject: string; task_description?: string; teammate_name?: string; team_name?: string }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TaskCompleted';
  };
}>;

type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  resume?: string;  // SDK session ID to resume
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('project' | 'user')[];
  canUseTool?: CanUseToolCallback;  // Pre-tool-use validation callback
  env?: { [envVar: string]: string | undefined };  // Environment variables for Claude Code process
  hooks?: {
    PreToolUse?: Array<{ hooks: PreToolUseHookCallback[] }>;
    TeammateIdle?: Array<{ hooks: TeammateIdleHookCallback[] }>;
    TaskCompleted?: Array<{ hooks: TaskCompletedHookCallback[] }>;
  };
};

// Thinking level to token budget mapping
const THINKING_BUDGETS: Record<string, number | undefined> = {
  'none': 0,
  'minimal': 2048,
  'normal': 10000,
  'extended': 32000,
};

// Image content for multimodal messages
export interface ImageContent {
  type: 'base64';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;  // base64 encoded
}

// Attachment info for tracking attachments in metadata
export interface AttachmentInfo {
  hasAttachment: boolean;
  attachmentType?: 'photo' | 'voice' | 'audio' | 'document' | 'location';
}

// Content block types for SDK
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type ContentBlock = TextBlock | ImageBlock;

// SDK User Message type for async iterable
interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

// Dynamic SDK loader - prompt can be string or async iterable of messages
let sdkQuery: ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: SDKOptions }) => SDKQuery) | null = null;

// Use Function to preserve native import() - TypeScript converts import() to require() in CommonJS
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  workspace?: string;  // Isolated working directory for agent file operations
  dataDir?: string;    // App data directory (e.g. ~/Library/Application Support/pocket-agent)
  model?: string;
  tools?: ToolsConfig;
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
  suggestedPrompt?: string;
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass extends EventEmitter {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private workspace: string = process.cwd();  // Isolated working directory for agent
  private model: string = 'claude-opus-4-6';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';
  private instructions: string = '';
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private lastSuggestedPromptBySession: Map<string, string | undefined> = new Map();
  private messageQueueBySession: Map<string, Array<{ message: string; channel: string; images?: ImageContent[]; attachmentInfo?: AttachmentInfo; resolve: (result: ProcessResult) => void; reject: (error: Error) => void }>> = new Map();
  private providerLock: Promise<void> = Promise.resolve();
  private sdkSessionIdBySession: Map<string, string> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): AgentManagerClass {
    if (!AgentManagerClass.instance) {
      AgentManagerClass.instance = new AgentManagerClass();
    }
    return AgentManagerClass.instance;
  }

  initialize(config: AgentConfig): void {
    this.memory = config.memory;
    this.projectRoot = config.projectRoot || process.cwd();
    this.workspace = config.workspace || this.projectRoot;
    this.model = config.model || 'claude-opus-4-6';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    // Isolate SDK session storage from global Claude Code installation
    if (config.dataDir) {
      process.env.CLAUDE_CONFIG_DIR = path.join(config.dataDir, '.claude');
    }

    this.identity = loadIdentity();
    this.instructions = loadInstructions();
    setMemoryManager(this.memory);
    setSoulMemoryManager(this.memory);

    // Set up safety status emitter for UI feedback on blocked tools
    setStatusEmitter((status) => {
      this.emitStatus(status);
    });

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Workspace:', this.workspace);
    console.log('[AgentManager] Model:', this.model);
    console.log('[AgentManager] Identity loaded:', this.identity.length, 'chars');
    console.log('[AgentManager] Instructions loaded:', this.instructions.length, 'chars');

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }

      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }

    // Backfill message embeddings asynchronously (for semantic retrieval)
    this.backfillMessageEmbeddings().catch(e => {
      console.error('[AgentManager] Embedding backfill failed:', e);
    });
  }

  /**
   * Backfill embeddings for messages that don't have them yet.
   * Runs asynchronously in the background during initialization.
   */
  private async backfillMessageEmbeddings(): Promise<void> {
    if (!this.memory) return;

    // Get all sessions and backfill each
    const sessions = this.memory.getSessions();
    for (const session of sessions) {
      const embedded = await this.memory.embedRecentMessages(session.id, 100);
      if (embedded > 0) {
        console.log(`[AgentManager] Backfilled ${embedded} embeddings for session ${session.id}`);
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
    SettingsManager.set('agent.model', model);
    console.log('[AgentManager] Model changed to:', model);
    this.emit('model:changed', model);
  }

  async processMessage(
    userMessage: string,
    channel: string = 'default',
    sessionId: string = 'default',
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    // If already processing, queue the message
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(userMessage, channel, sessionId, images, attachmentInfo);
    }

    return this.executeMessage(userMessage, channel, sessionId, images, attachmentInfo);
  }

  /**
   * Queue a message to be processed after the current one finishes
   */
  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // Get or create queue for this session
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;

      // Add to queue
      queue.push({ message: userMessage, channel, images, attachmentInfo, resolve, reject });

      const queuePosition = queue.length;
      console.log(`[AgentManager] Message queued at position ${queuePosition} for session ${sessionId}`);

      // Emit queued status
      this.emitStatus({
        type: 'queued',
        sessionId,
        queuePosition,
        queuedMessage: userMessage.slice(0, 100),
        message: `in the litter queue (#${queuePosition})`,
      });
    });
  }

  /**
   * Process the next message in the queue for a session
   */
  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.messageQueueBySession.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    console.log(`[AgentManager] Processing queued message for session ${sessionId}, ${queue.length} remaining`);

    // Emit status that we're processing a queued message
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
   * Actually execute a message (internal implementation)
   */
  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    // Memory should already be checked by processMessage, but guard anyway
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const memory = this.memory; // Local reference for TypeScript narrowing

    this.processingBySession.set(sessionId, true);
    const abortController = new AbortController();
    this.abortControllersBySession.set(sessionId, abortController);
    this.lastSuggestedPromptBySession.set(sessionId, undefined);
    let wasCompacted = false;

    // Wrap entire execution in AsyncLocalStorage context so all tool callbacks
    // within the SDK's query() inherit the correct session ID
    return runWithSessionId(sessionId, async () => {
    try {
      // Look up SDK session for resume (in-memory cache first, then DB)
      let sdkSessionId = this.sdkSessionIdBySession.get(sessionId)
        || memory.getSdkSessionId(sessionId)
        || undefined;

      const factsContext = memory.getFactsForContext();
      const soulContext = memory.getSoulContext();

      // Get last message timestamp for temporal context (lightweight query)
      const recentMsgs = memory.getRecentMessages(1, sessionId);
      const lastUserMsg = recentMsgs.find(m => m.role === 'user');
      const lastUserMessageTimestamp = lastUserMsg?.timestamp;

      if (sdkSessionId) {
        console.log(`[AgentManager] Resuming SDK session: ${sdkSessionId}`);
      } else {
        console.log('[AgentManager] Starting new SDK session');
      }

      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      // Helper to launch and iterate an SDK query
      const runQuery = async (opts: SDKOptions): Promise<string> => {
        const queryResult = await new Promise<SDKQuery>((resolve) => {
          this.providerLock = this.providerLock.then(() => {
            configureProviderEnvironment(this.model);

            // Capture env AFTER provider config so correct vars are set
            // Remove CLAUDE_CONFIG_DIR so SDK child process uses global ~/.claude/
            // for Keychain-based OAuth. Sessions use unique IDs so no conflict.
            opts.env = {
              ...process.env,
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            };
            delete opts.env.CLAUDE_CONFIG_DIR;

            if (images && images.length > 0) {
              // For images, create an async generator that yields SDKUserMessage
              const contentBlocks: ContentBlock[] = [
                { type: 'text', text: userMessage },
                ...images.map(img => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mediaType,
                    data: img.data,
                  },
                })),
              ];

              async function* messageGenerator() {
                yield {
                  type: 'user' as const,
                  message: {
                    role: 'user' as const,
                    content: contentBlocks,
                  },
                  parent_tool_use_id: null,
                  session_id: 'default',
                };
              }

              console.log(`[AgentManager] Calling query() with ${images.length} image(s)`);
              resolve(query({ prompt: messageGenerator(), options: opts }));
            } else {
              resolve(query({ prompt: userMessage, options: opts }));
            }
          });
        });

        let result = '';
        for await (const message of queryResult) {
          if (abortController.signal.aborted) {
            console.log('[AgentManager] Query aborted by user');
            throw new Error('Query stopped by user');
          }

          this.processStatusFromMessage(message);
          result = this.extractFromMessage(message, result);

          // Capture SDK session ID for future resume
          const msg = message as { type?: string; subtype?: string; session_id?: string };
          if (msg.session_id && !sdkSessionId) {
            sdkSessionId = msg.session_id;
            this.sdkSessionIdBySession.set(sessionId, sdkSessionId);
            memory.setSdkSessionId(sessionId, sdkSessionId);
            console.log(`[AgentManager] Captured SDK session ID: ${sdkSessionId}`);
          }

          // Detect SDK auto-compaction
          if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            wasCompacted = true;
          }
        }
        return result;
      };

      let options = await this.buildOptions(factsContext, soulContext, abortController, lastUserMessageTimestamp, sdkSessionId);

      // Build prompt - use async generator for images, string for text-only
      console.log('[AgentManager] Calling query() with model:', options.model, 'thinking:', options.maxThinkingTokens || 'default');
      this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

      let response = '';
      try {
        response = await runQuery(options);
      } catch (resumeError) {
        // If resume failed (corrupted/missing SDK session), retry without resume
        if (sdkSessionId && !abortController.signal.aborted) {
          const errMsg = resumeError instanceof Error ? resumeError.message : String(resumeError);
          console.warn(`[AgentManager] Resume failed (${errMsg}), retrying without resume...`);
          sdkSessionId = undefined;
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
          options = await this.buildOptions(factsContext, soulContext, abortController, lastUserMessageTimestamp, undefined);
          response = await runQuery(options);
        } else {
          throw resumeError;
        }
      }

      this.emitStatus({ type: 'done', sessionId });

      // If no text response, make a follow-up call to get one
      if (!response) {
        console.log('[AgentManager] No text response, requesting summary...');
        this.emitStatus({ type: 'thinking', sessionId, message: 'summarizing...' });

        const summaryResult = query({
          prompt: 'Briefly summarize what you just did in 1-2 sentences.',
          options: {
            ...options,
            maxThinkingTokens: undefined, // No extended thinking for summary
            ...(sdkSessionId && { resume: sdkSessionId }),
          },
        });

        for await (const message of summaryResult) {
          if (abortController.signal.aborted) break;
          response = this.extractFromMessage(message, response);
        }

        // Final fallback if summary also fails
        if (!response) {
          response = 'Done.';
        }

        this.emitStatus({ type: 'done', sessionId });
      }

      // Skip saving HEARTBEAT_OK responses from scheduled jobs to memory/chat
      const isScheduledJob = channel.startsWith('cron:');
      const isHeartbeat = response.toUpperCase().includes('HEARTBEAT_OK');

      if (isScheduledJob && isHeartbeat) {
        console.log('[AgentManager] Skipping HEARTBEAT_OK from scheduled job - not saving to memory');
      } else {
        // Clean up scheduled job messages before saving - remove internal LLM instructions
        let messageToSave = userMessage;

        // Strip the heartbeat instruction suffix (for routines)
        const heartbeatSuffix = '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';
        if (messageToSave.endsWith(heartbeatSuffix)) {
          messageToSave = messageToSave.slice(0, -heartbeatSuffix.length);
        }

        // Convert reminder prompts to clean display format (for reminders)
        const reminderMatch = messageToSave.match(/^\[SCHEDULED REMINDER - DELIVER NOW\]\nThe user previously asked to be reminded about: "(.+?)"\n\nDeliver this reminder/);
        if (reminderMatch) {
          messageToSave = `Reminder: ${reminderMatch[1]}`;
        }

        // Add metadata for message source and attachments
        let metadata: Record<string, unknown> | undefined;
        if (channel.startsWith('cron:')) {
          metadata = { source: 'scheduler', jobName: channel.slice(5) };
        } else if (channel === 'telegram') {
          // Use explicit attachmentInfo if provided, otherwise check for images
          const hasAttachment = attachmentInfo?.hasAttachment ?? (images && images.length > 0);
          const attachmentType = attachmentInfo?.attachmentType ?? (images && images.length > 0 ? 'photo' : undefined);
          metadata = { source: 'telegram', hasAttachment, attachmentType };
        }

        const userMsgId = memory.saveMessage('user', messageToSave, sessionId, metadata);
        // Assistant response doesn't need hasAttachment but keep source for consistency
        const assistantMetadata = metadata ? { source: metadata.source } : undefined;
        const assistantMsgId = memory.saveMessage('assistant', response, sessionId, assistantMetadata);
        console.log('[AgentManager] Saved messages to SQLite (session: ' + sessionId + ')');

        // Embed messages asynchronously for future semantic retrieval
        // Don't await - let it run in background
        memory.embedMessage(userMsgId).catch(e => console.error('[AgentManager] Failed to embed user message:', e));
        memory.embedMessage(assistantMsgId).catch(e => console.error('[AgentManager] Failed to embed assistant message:', e));
      }

      this.extractAndStoreFacts(userMessage);

      const statsAfter = memory.getStats();

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPromptBySession.get(sessionId),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AgentManager] Query failed:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[AgentManager] Stack trace:', error.stack);
      }
      // Log full error object for debugging
      console.error('[AgentManager] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      // Only save user message if not aborted
      if (!abortController.signal.aborted) {
        memory.saveMessage('user', userMessage, sessionId);
      }

      throw error;
    } finally {
      this.processingBySession.set(sessionId, false);
      this.abortControllersBySession.delete(sessionId);

      // Process next message in queue (if any)
      // Use setTimeout(0) to avoid blocking the current promise resolution
      setTimeout(() => {
        this.processQueue(sessionId).catch((err) => {
          console.error('[AgentManager] Queue processing failed:', err);
        });
      }, 0);
    }
    }); // end runWithSessionId
  }

  /**
   * Get the number of queued messages for a session
   */
  getQueueLength(sessionId: string = 'default'): number {
    return this.messageQueueBySession.get(sessionId)?.length || 0;
  }

  /**
   * Clear the message queue for a session
   */
  clearQueue(sessionId: string = 'default'): void {
    const queue = this.messageQueueBySession.get(sessionId);
    if (queue && queue.length > 0) {
      // Reject all pending messages
      for (const item of queue) {
        item.reject(new Error('Queue cleared'));
      }
      // Delete the key entirely to prevent memory leak from accumulated empty arrays
      this.messageQueueBySession.delete(sessionId);
      console.log(`[AgentManager] Queue cleared for session ${sessionId}`);
    } else if (queue) {
      // Clean up empty queue entries
      this.messageQueueBySession.delete(sessionId);
    }
  }

  /**
   * Stop the query for a specific session (or any running query if no sessionId)
   * Also clears any queued messages for that session
   */
  stopQuery(sessionId?: string, clearQueuedMessages: boolean = true): boolean {
    if (sessionId) {
      // Clear the queue first
      if (clearQueuedMessages) {
        this.clearQueue(sessionId);
      }

      const abortController = this.abortControllersBySession.get(sessionId);
      if (this.processingBySession.get(sessionId) && abortController) {
        console.log(`[AgentManager] Stopping query for session ${sessionId}...`);
        abortController.abort();
        // Note: Don't emit 'done' here - it would broadcast to ALL sessions.
        // The frontend handles cleanup on its end when stopping/deleting a session.
        return true;
      }
      return false;
    }

    // Legacy: stop any running query (first one found)
    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        if (clearQueuedMessages) {
          this.clearQueue(sid);
        }
        const abortController = this.abortControllersBySession.get(sid);
        if (abortController) {
          console.log(`[AgentManager] Stopping query for session ${sid}...`);
          abortController.abort();
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a query is currently processing (optionally for a specific session)
   */
  isQueryProcessing(sessionId?: string): boolean {
    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    // Check if any session is processing
    for (const isProcessing of this.processingBySession.values()) {
      if (isProcessing) return true;
    }
    return false;
  }

  /**
   * Get the current workspace directory
   */
  getWorkspace(): string {
    return this.workspace;
  }

  /**
   * Get the default project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Set the workspace directory for agent file operations.
   * This takes effect on the next SDK query (cwd option).
   * Clears SDK session mappings since sessions are tied to cwd.
   */
  setWorkspace(path: string): void {
    console.log('[AgentManager] Workspace changed:', this.workspace, '->', path);
    this.workspace = path;
    // SDK sessions are stored per-cwd, so changing cwd invalidates them
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Reset workspace to default project root
   * Clears SDK session mappings since sessions are tied to cwd.
   */
  resetWorkspace(): void {
    console.log('[AgentManager] Workspace reset to project root:', this.projectRoot);
    this.workspace = this.projectRoot;
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Clear the SDK session mapping for a given session (e.g., on session delete or clear)
   */
  clearSdkSessionMapping(sessionId: string): void {
    this.sdkSessionIdBySession.delete(sessionId);
    console.log(`[AgentManager] Cleared SDK session mapping for ${sessionId}`);
  }

  private async buildOptions(factsContext: string, soulContext: string, abortController: AbortController, lastMessageTimestamp?: string, sdkSessionId?: string): Promise<SDKOptions> {
    const appendParts: string[] = [];

    // Add temporal context first (current time awareness)
    const temporalContext = this.buildTemporalContext(lastMessageTimestamp);
    appendParts.push(temporalContext);

    if (this.instructions) {
      appendParts.push(this.instructions);
    }

    if (this.identity) {
      appendParts.push(this.identity);
    }

    // Add user profile from settings
    const userProfile = SettingsManager.getFormattedProfile();
    if (userProfile) {
      appendParts.push(userProfile);
    }

    if (factsContext) {
      appendParts.push(factsContext);
    }

    if (soulContext) {
      appendParts.push(soulContext);
    }

    // Add daily logs context (recent activity journal)
    const dailyLogsContext = this.memory?.getDailyLogsContext(3);
    if (dailyLogsContext) {
      appendParts.push(dailyLogsContext);
    }

    // Add capabilities information
    const capabilities = this.buildCapabilitiesPrompt();
    if (capabilities) {
      appendParts.push(capabilities);
    }

    // Get thinking level and convert to token budget
    const thinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
    const thinkingBudget = THINKING_BUDGETS[thinkingLevel];

    const options: SDKOptions = {
      model: this.model,
      cwd: this.workspace,  // Use isolated workspace for agent file operations
      maxTurns: 100,
      ...(thinkingBudget !== undefined && thinkingBudget > 0 && { maxThinkingTokens: thinkingBudget }),
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
      canUseTool: buildCanUseToolCallback(),  // Pre-tool-use safety validation
      // env is set dynamically in runQuery() after configureProviderEnvironment()
      hooks: {
        PreToolUse: [buildPreToolUseHook()],  // Pre-tool-use safety hook
        TeammateIdle: [{
          hooks: [async (input: { teammate_name: string; team_name: string }) => {
            this.emitStatus({
              type: 'teammate_idle',
              teammateName: input.teammate_name,
              teamName: input.team_name,
              message: `${input.teammate_name} is idle`,
            });
            return { hookSpecificOutput: { hookEventName: 'TeammateIdle' as const } };
          }],
        }],
        TaskCompleted: [{
          hooks: [async (input: { task_id: string; task_subject: string; task_description?: string; teammate_name?: string; team_name?: string }) => {
            this.emitStatus({
              type: 'task_completed',
              taskId: input.task_id,
              taskSubject: input.task_subject,
              teammateName: input.teammate_name,
              teamName: input.team_name,
              message: `task done: ${input.task_subject}`,
            });
            return { hookSpecificOutput: { hookEventName: 'TaskCompleted' as const } };
          }],
        }],
      },
      allowedTools: [
        // Built-in SDK tools
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        // Agent Teams tools
        'TeammateTool', 'TeamCreate', 'SendMessage', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
        // Background task tools
        'TaskOutput', 'TaskStop',
        // Custom MCP tools - browser & system
        'mcp__pocket-agent__browser',
        'mcp__pocket-agent__notify',
        // Custom MCP tools - memory
        'mcp__pocket-agent__remember',
        'mcp__pocket-agent__forget',
        'mcp__pocket-agent__list_facts',
        'mcp__pocket-agent__memory_search',
        'mcp__pocket-agent__daily_log',
        // Custom MCP tools - soul
        'mcp__pocket-agent__soul_set',
        'mcp__pocket-agent__soul_get',
        'mcp__pocket-agent__soul_list',
        'mcp__pocket-agent__soul_delete',
        // Custom MCP tools - scheduler
        'mcp__pocket-agent__schedule_task',
        'mcp__pocket-agent__create_reminder',
        'mcp__pocket-agent__list_scheduled_tasks',
        'mcp__pocket-agent__delete_scheduled_task',
        // Custom MCP tools - calendar
        'mcp__pocket-agent__calendar_add',
        'mcp__pocket-agent__calendar_list',
        'mcp__pocket-agent__calendar_upcoming',
        'mcp__pocket-agent__calendar_delete',
        // Custom MCP tools - tasks
        'mcp__pocket-agent__task_add',
        'mcp__pocket-agent__task_list',
        'mcp__pocket-agent__task_complete',
        'mcp__pocket-agent__task_delete',
        'mcp__pocket-agent__task_due',
        // Custom MCP tools - project
        'mcp__pocket-agent__set_project',
        'mcp__pocket-agent__get_project',
        'mcp__pocket-agent__clear_project',
      ],
      persistSession: true,
      ...(sdkSessionId && { resume: sdkSessionId }),
    };

    if (appendParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: appendParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      // Build child process MCP servers (e.g., computer use)
      const mcpServers = buildMCPServers(this.toolsConfig);

      // Build SDK MCP servers (in-process tools like browser, notify, memory)
      const sdkMcpServers = await buildSdkMcpServers(this.toolsConfig);

      // Merge both types
      const allServers = {
        ...mcpServers,
        ...(sdkMcpServers || {}),
      };

      if (Object.keys(allServers).length > 0) {
        options.mcpServers = allServers;
        console.log('[AgentManager] MCP servers:', Object.keys(allServers).join(', '));
      }
    }

    return options;
  }

  private buildCapabilitiesPrompt(): string {
    return `## Your Capabilities as Pocket Agent

You are a persistent personal AI assistant with special capabilities.

### Your Workspace
Your working directory is: ${this.workspace}
This is an isolated environment separate from the application code.
All file operations (reading, writing, creating projects) happen here by default.
Feel free to create subdirectories, projects, and files as needed.

### Scheduling & Reminders
Use the schedule_task tool to create reminders. Three schedule formats are supported:

- One-time: "in 10 minutes", "in 2 hours", "tomorrow 3pm", "monday 9am"
- Interval: "30m", "2h", "1d" (runs every X)
- Cron: "0 9 * * *" (minute hour day month weekday)

Examples:
- schedule_task(name="call_mom", schedule="in 2 hours", prompt="Time to call mom!")
- schedule_task(name="water", schedule="2h", prompt="Time to drink water!")
- schedule_task(name="standup", schedule="0 9 * * 1-5", prompt="Daily standup time")

Use list_scheduled_tasks to see all scheduled tasks.
Use delete_scheduled_task to remove a task.

RULES:
- Use short, clean names (water, standup, break) - NO timestamps
- One-time jobs auto-delete after running

### Calendar Events
Use calendar tools to manage events with reminders:

- calendar_add: Create an event with optional reminder
- calendar_list: List events for a date
- calendar_upcoming: Show upcoming events
- calendar_delete: Remove an event

Time formats: "today 3pm", "tomorrow 9am", "monday 2pm", "in 2 hours", ISO format
Reminders trigger automatically before the event starts.

### Tasks / Todos
Use task tools to manage tasks with due dates and priorities:

- task_add: Create a task with optional due date, priority (low/medium/high), reminder
- task_list: List tasks by status (pending/completed/all)
- task_complete: Mark a task as done
- task_delete: Remove a task
- task_due: Show tasks due soon

Priorities: low, medium, high
Status: pending, in_progress, completed

### Memory & Facts
You have persistent memory! PROACTIVELY save important info when the user shares it.

Use memory tools:
- remember: Save a fact (category, key, value)
- forget: Delete a fact
- list_facts: List all facts or by category
- memory_search: Search facts by keyword

Categories: user_info, preferences, projects, people, work, notes, decisions

IMPORTANT: Save facts PROACTIVELY when user mentions:
- Personal info (name, birthday, location)
- Preferences (favorite things, likes/dislikes)
- Projects they're working on
- People important to them
- Work/job details

### Browser Automation
You have a browser tool for JS rendering and authenticated sessions:

\`\`\`
Actions:
- navigate: Go to URL
- screenshot: Capture page image
- click: Click an element
- type: Enter text in input
- evaluate: Run JavaScript
- extract: Get page data (text/html/links/tables/structured)
- scroll: Scroll page or element (up/down/left/right)
- hover: Hover over element (triggers dropdowns)
- download: Download a file
- upload: Upload file to input
- tabs_list: List open tabs (CDP tier only)
- tabs_open: Open new tab (CDP tier only)
- tabs_close: Close a tab (CDP tier only)
- tabs_focus: Switch to tab (CDP tier only)

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions + multi-tab

Set requires_auth=true for pages needing login.
For CDP, user must start Chrome with: --remote-debugging-port=9222
\`\`\`

### Native Notifications
You can send native desktop notifications:

\`\`\`bash
# Use the notify tool to alert the user
notify(title="Task Complete", body="Your download has finished")
notify(title="Reminder", body="Meeting in 5 minutes", urgency="critical")
\`\`\`

### Limitations
- Cannot send SMS or make calls
- For full desktop automation, user needs to enable Computer Use (Docker-based)`;
  }

  private extractFromMessage(message: unknown, current: string): string {
    const msg = message as { type?: string; message?: { content?: unknown }; output?: string; result?: string };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        // If no text blocks (tool-only turn), preserve the accumulated response
        if (textBlocks.length === 0) {
          return current;
        }
        const text = textBlocks.join('\n');
        // Extract and strip any trailing "User:" suggested prompts
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(text);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        return cleanedText;
      }
    }

    if (msg.type === 'result') {
      const result = msg.output || msg.result;
      if (result) {
        // Extract and strip any trailing "User:" suggested prompts from result
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(result);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        return cleanedText;
      }
    }

    return current;
  }

  /**
   * Extract and strip trailing suggested user prompts that the SDK might include
   * These appear as "User: ..." at the end of responses
   * Returns both the cleaned text and the extracted suggestion
   */
  private extractSuggestedPrompt(text: string): { text: string; suggestion?: string } {
    if (!text) return { text };

    // Pattern: newlines followed by "User:" (case-insensitive) and any text until end
    const match = text.match(/\n\nuser:\s*(.+)$/is);

    if (match) {
      const suggestion = match[1].trim();
      const cleanedText = text.replace(/\n\nuser:[\s\S]*$/is, '').trim();

      // Validate that the suggestion looks like a user prompt, not an assistant question
      const isValidUserPrompt = this.isValidUserPrompt(suggestion);

      if (isValidUserPrompt) {
        console.log('[AgentManager] Extracted suggested prompt:', suggestion);
        return { text: cleanedText, suggestion };
      } else {
        console.log('[AgentManager] Rejected invalid suggestion (assistant-style):', suggestion);
        return { text: cleanedText }; // Strip but don't use as suggestion
      }
    }

    return { text: text.trim() };
  }

  /**
   * Check if a suggestion looks like a valid user prompt
   * Rejects questions and assistant-style speech
   */
  private isValidUserPrompt(suggestion: string): boolean {
    if (!suggestion) return false;

    // Reject if it ends with a question mark (assistant asking a question)
    if (suggestion.endsWith('?')) return false;

    // Reject if it starts with common question/assistant words
    const assistantPatterns = /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
    if (assistantPatterns.test(suggestion)) return false;

    // Reject if it's too long (likely not a simple user command)
    if (suggestion.length > 100) return false;

    // Accept short, command-like suggestions
    return true;
  }

  private emitStatus(status: AgentStatus): void {
    this.emit('status', status);
  }

  // Track active subagents per session
  private activeSubagentsBySession: Map<string, Map<string, { type: string; description: string }>> = new Map();
  // Track background tasks per session
  private backgroundTasksBySession: Map<string, Map<string, { type: string; description: string; toolUseId: string }>> = new Map();

  private getActiveSubagents(sessionId: string): Map<string, { type: string; description: string }> {
    let map = this.activeSubagentsBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.activeSubagentsBySession.set(sessionId, map);
    }
    return map;
  }

  private getBackgroundTasks(sessionId: string): Map<string, { type: string; description: string; toolUseId: string }> {
    let map = this.backgroundTasksBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.backgroundTasksBySession.set(sessionId, map);
    }
    return map;
  }

  private processStatusFromMessage(message: unknown): void {
    const sessionId = getCurrentSessionId();
    const activeSubagents = this.getActiveSubagents(sessionId);
    const backgroundTasks = this.getBackgroundTasks(sessionId);

    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            const rawName = block.name as string;
            const toolName = this.formatToolName(rawName);
            const toolInput = this.formatToolInput(block.input);
            const blockInput = block.input as Record<string, unknown>;
            const toolUseId = (block.id as string) || `bg-${Date.now()}`;

            // Detect background tasks (Bash or Task with run_in_background)
            if (blockInput?.run_in_background === true) {
              const bgId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const description = (rawName === 'Bash'
                ? (blockInput.command as string)?.slice(0, 60)
                : (blockInput.description as string) || (blockInput.prompt as string)?.slice(0, 60)
              ) || rawName;

              backgroundTasks.set(bgId, { type: rawName, description, toolUseId });
              console.log(`[AgentManager] Background task started: ${rawName} - ${description} (${backgroundTasks.size} active)`);

              this.emitStatus({
                type: 'background_task_start',
                sessionId,
                backgroundTaskId: bgId,
                backgroundTaskDescription: description,
                backgroundTaskCount: backgroundTasks.size,
                toolName: rawName,
                message: `background: ${description}`,
              });
            }

            // Detect TaskOutput (checking on background tasks)
            if (rawName === 'TaskOutput') {
              this.emitStatus({
                type: 'background_task_output',
                sessionId,
                backgroundTaskId: blockInput.task_id as string,
                backgroundTaskCount: backgroundTasks.size,
                message: 'checking background task...',
              });
            }

            // Check if this is a Task (subagent) tool
            if (rawName === 'Task') {
              const input = block.input as { subagent_type?: string; description?: string; prompt?: string };
              const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const agentType = input.subagent_type || 'general';
              const description = input.description || input.prompt?.slice(0, 50) || 'working on it';

              activeSubagents.set(agentId, { type: agentType, description });

              this.emitStatus({
                type: 'subagent_start',
                sessionId,
                agentId,
                agentType,
                toolInput: description,
                agentCount: activeSubagents.size,
                message: this.getSubagentMessage(agentType),
              });
            } else if (rawName === 'TeammateTool') {
              const input = block.input as { name?: string; team_name?: string; description?: string };
              this.emitStatus({
                type: 'teammate_start',
                sessionId,
                teammateName: input.name,
                teamName: input.team_name,
                toolName,
                toolInput: input.description || input.name || 'spawning teammate',
                message: `rallying ${input.name || 'a teammate'}`,
              });
            } else if (rawName === 'SendMessage') {
              const input = block.input as { to?: string; type?: string; message?: string };
              this.emitStatus({
                type: 'teammate_message',
                sessionId,
                teammateName: input.to,
                toolName,
                toolInput: input.message?.slice(0, 80) || '',
                message: input.type === 'broadcast' ? 'broadcasting to the squad' : `messaging ${input.to || 'teammate'}`,
              });
            } else if (rawName === 'Bash' && this.isPocketCliCommand(block.input)) {
              const pocketName = this.formatPocketCommand(block.input);
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName: pocketName,
                toolInput,
                message: `batting at ${pocketName}...`,
                isPocketCli: true,
              });
            } else {
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName,
                toolInput,
                message: `batting at ${toolName}...`,
              });
            }
          }
        }
      }
    }

    // Handle tool results
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            // Check if any subagents completed
            if (activeSubagents.size > 0) {
              // Remove one subagent (we don't have exact ID matching, so remove oldest)
              const firstKey = activeSubagents.keys().next().value;
              if (firstKey) {
                activeSubagents.delete(firstKey);
              }

              if (activeSubagents.size > 0) {
                // Still have active subagents
                this.emitStatus({
                  type: 'subagent_update',
                  sessionId,
                  agentCount: activeSubagents.size,
                  message: `${activeSubagents.size} kitty${activeSubagents.size > 1 ? 'ies' : ''} still hunting`,
                });
              } else {
                this.emitStatus({
                  type: 'subagent_end',
                  sessionId,
                  agentCount: 0,
                  message: 'squad done! cleaning up...',
                });
              }
            } else {
              this.emitStatus({
                type: 'tool_end',
                sessionId,
                message: 'caught it! processing...',
              });
            }
          }
        }
      }
    }

    // Handle system messages
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        this.emitStatus({ type: 'thinking', sessionId, message: 'waking up from a nap...' });
      } else if (msg.subtype === 'status') {
        const statusMsg = msg as { status?: string };
        if (statusMsg.status === 'compacting') {
          console.log('[AgentManager] SDK auto-compaction triggered');
          this.emitStatus({ type: 'thinking', sessionId, message: 'compacting context...' });
        }
      } else if (msg.subtype === 'compact_boundary') {
        const compactMsg = msg as { compact_metadata?: { trigger: string; pre_tokens: number } };
        const meta = compactMsg.compact_metadata;
        console.log(`[AgentManager] SDK compaction complete: trigger=${meta?.trigger}, pre_tokens=${meta?.pre_tokens}`);
      }
    }
  }

  private getSubagentMessage(agentType: string): string {
    const messages: Record<string, string> = {
      'Explore': 'sent a curious kitten to explore',
      'Plan': 'calling in the architect cat',
      'Bash': 'summoning a terminal tabby',
      'general-purpose': 'summoning a helper kitty',
    };
    return messages[agentType] || `summoning ${agentType} cat friend`;
  }

  private formatToolName(name: string): string {
    // Fun, cat-themed tool names that match PA's vibe
    const friendlyNames: Record<string, string> = {
      // SDK built-in tools
      Read: 'sniffing this file',
      Write: 'scratching notes down',
      Edit: 'pawing at some code',
      Bash: 'hacking at the terminal',
      Glob: 'hunting for files',
      Grep: 'digging through code',
      WebSearch: 'prowling the web',
      WebFetch: 'fetching that page',
      Task: 'summoning a helper kitty',
      NotebookEdit: 'editing notebook',

      // Memory tools
      remember: 'stashing in my cat brain',
      forget: 'knocking it off the shelf',
      list_facts: 'checking my memories',
      memory_search: 'sniffing through archives',

      // Browser tool
      browser: 'pouncing on browser',

      // Computer use tool
      computer: 'walking on the keyboard',

      // Scheduler tools
      schedule_task: 'setting an alarm meow',
      list_scheduled_tasks: 'checking the schedule',
      delete_scheduled_task: 'knocking that off',

      // macOS tools
      notify: 'sending a meow',

      // Task tools
      task_add: 'adding to the hunt list',
      task_list: 'checking your tasks',
      task_complete: 'caught it!',
      task_delete: 'batting that away',
      task_due: 'sniffing what\'s due',

      // Calendar tools
      calendar_add: 'marking territory',
      calendar_list: 'checking the calendar',
      calendar_upcoming: 'seeing what\'s coming up',
      calendar_delete: 'scratching that out',

      // Agent Teams tools
      TeammateTool: 'rallying the squad',
      TeamCreate: 'rallying the squad',
      SendMessage: 'passing a note',
      TaskCreate: 'creating a team task',
      TaskGet: 'checking task details',
      TaskUpdate: 'updating team task',
      TaskList: 'listing team tasks',
      TaskOutput: 'checking background task',
      TaskStop: 'stopping background task',
    };
    return friendlyNames[name] || name;
  }

  private formatToolInput(input: unknown): string {
    if (!input) return '';
    // Extract meaningful info from tool input
    if (typeof input === 'string') return input.slice(0, 100);
    const inp = input as Record<string, string | number[] | undefined>;

    // File operations
    if (inp.file_path) return inp.file_path as string;
    if (inp.notebook_path) return inp.notebook_path as string;

    // Search/patterns
    if (inp.pattern) return inp.pattern as string;
    if (inp.query) return inp.query as string;

    // Commands
    if (inp.command) return (inp.command as string).slice(0, 80);

    // Web
    if (inp.url) return inp.url as string;

    // Agent/Task
    if (inp.prompt) return (inp.prompt as string).slice(0, 80);
    if (inp.description) return (inp.description as string).slice(0, 80);

    // Memory tools
    if (inp.category && inp.subject) return `${inp.category}/${inp.subject}`;
    if (inp.content) return (inp.content as string).slice(0, 80);

    // Browser tool
    if (inp.action) {
      const browserActions: Record<string, string> = {
        navigate: inp.url ? `→ ${inp.url}` : 'navigating',
        screenshot: 'capturing screen',
        click: inp.selector ? `clicking ${inp.selector}` : 'clicking',
        type: inp.text ? `typing "${(inp.text as string).slice(0, 30)}"` : 'typing',
        evaluate: 'running script',
        extract: (inp.extract_type as string) || 'extracting data',
      };
      return browserActions[inp.action as string] || (inp.action as string);
    }

    // Computer use
    if (inp.coordinate && Array.isArray(inp.coordinate) && inp.coordinate.length >= 2) {
      return `at (${inp.coordinate[0]}, ${inp.coordinate[1]})`;
    }
    if (inp.text) return `"${(inp.text as string).slice(0, 40)}"`;

    // Agent Teams tools
    if (inp.to && inp.message) return `→ ${inp.to}: ${(inp.message as string).slice(0, 60)}`;
    if (inp.name && inp.team_name) return `${inp.name} in ${inp.team_name}`;
    if (inp.name) return inp.name as string;

    return '';
  }

  private isPocketCliCommand(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== 'string') return false;
    return command.trimStart().startsWith('pocket');
  }

  private formatPocketCommand(input: unknown): string {
    if (!input || typeof input !== 'object') return 'running pocket cli';
    const command = ((input as Record<string, unknown>).command as string) || '';
    const parts = command.trimStart().split(/\s+/);
    const subcommand = parts[1] || '';
    const categories: Record<string, string> = {
      news: 'fetching the latest news',
      utility: 'running pocket utility',
      knowledge: 'checking the knowledge base',
      dev: 'querying dev tools',
      commands: 'listing pocket commands',
      setup: 'configuring pocket',
      integrations: 'checking integrations',
    };
    return categories[subcommand] || 'running pocket cli';
  }

  /**
   * Parse database timestamp
   * If user has timezone configured, treat DB timestamps as UTC
   * Otherwise, use system local time (original behavior)
   */
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

  /**
   * Build temporal context for the system prompt
   * Gives the agent awareness of current time and conversation timing
   */
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

  private extractAndStoreFacts(userMessage: string): void {
    if (!this.memory) return;

    const patterns: Array<{ pattern: RegExp; category: string; subject: string }> = [
      { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /call me (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /i live in ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i'm from ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i work (?:at|for) ([^.,]+)/i, category: 'work', subject: 'employer' },
      { pattern: /i work as (?:a |an )?([^.,]+)/i, category: 'work', subject: 'role' },
      { pattern: /my job is ([^.,]+)/i, category: 'work', subject: 'role' },
    ];

    for (const { pattern, category, subject } of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        this.memory.saveFact(category, subject, match[1].trim());
        console.log(`[AgentManager] Extracted fact: [${category}] ${subject}: ${match[1]}`);
      }
    }
  }

  // ============ Public API ============

  getStats(sessionId?: string): ReturnType<MemoryManager['getStats']> | null {
    return this.memory?.getStats(sessionId) || null;
  }

  clearConversation(sessionId?: string): void {
    this.memory?.clearConversation(sessionId);
    console.log('[AgentManager] Conversation cleared' + (sessionId ? ` (session: ${sessionId})` : ''));
  }

  getMemory(): MemoryManager | null {
    return this.memory;
  }

  searchFacts(queryStr: string): Array<{ category: string; subject: string; content: string }> {
    return this.memory?.searchFacts(queryStr) || [];
  }

  saveFact(category: string, subject: string, content: string): void {
    this.memory?.saveFact(category, subject, content);
  }

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getRecentMessages(limit: number = 10, sessionId: string = 'default'): Message[] {
    return this.memory?.getRecentMessages(limit, sessionId) || [];
  }

  getToolsConfig(): ToolsConfig | null {
    return this.toolsConfig;
  }

  cleanup(): void {
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
export { AgentManagerClass };
