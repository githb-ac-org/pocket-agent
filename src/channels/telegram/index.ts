/**
 * Telegram channel - Main orchestrator
 *
 * Modular Telegram bot with:
 * - Text, photo, voice, audio message handling
 * - Document processing (PDF, code, CSV)
 * - Location sharing with reverse geocoding
 * - Inline keyboards with callbacks
 * - Reply keyboards (persistent)
 * - Message reactions
 */

import { Bot, Context, InputFile } from 'grammy';
import { BaseChannel } from '../index';
import { SettingsManager } from '../../settings';
import fs from 'fs';

// Types
import { MessageCallback, SessionLinkCallback, AttachmentType } from './types';

// Formatting
import { markdownToTelegramHtml, splitMessage } from './formatting';

// Middleware
import { createAuthMiddleware, getAllowedUsers } from './middleware/auth';
import { ChatTracker, createTrackingMiddleware } from './middleware/tracking';

// Handlers
import {
  registerCommandHandlers,
  registerSessionHandlers,
  CommandHandlerDeps,
} from './handlers/commands';
import { handleTextMessage } from './handlers/messages';
import { handlePhotoMessage, handleVoiceMessage, handleAudioMessage } from './handlers/media';
import { handleDocumentMessage } from './handlers/documents';
import { handleLocationMessage, handleEditedLocation } from './handlers/location';
import { registerCallbackHandler, CallbackHandlerDeps } from './handlers/callbacks';

// Features
import {
  createReactionHandler,
  registerReactionHandler,
} from './features/reactions';

// Re-export types
export type { MessageCallback, SessionLinkCallback, AttachmentType };

// Re-export utilities for external use
export { markdownToTelegramHtml, splitMessage } from './formatting';
export { InlineKeyboardBuilder } from './keyboards/inline';

/**
 * TelegramBot - Main Telegram channel implementation
 */
export class TelegramBot extends BaseChannel {
  name = 'telegram';
  private bot: Bot;
  private chatTracker: ChatTracker;
  private onMessageCallback: MessageCallback | null = null;
  private onSessionLinkCallback: SessionLinkCallback | null = null;

  constructor() {
    super();
    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }

    const allowedUsers = getAllowedUsers();

    // Security: Require at least one allowed user ID
    if (allowedUsers.length === 0) {
      throw new Error(
        'Telegram allowlist is empty. For security, you must add at least one user ID.\n\n' +
        'To get your Telegram user ID:\n' +
        '1. Open Telegram and message @userinfobot\n' +
        '2. It will reply with your user ID\n' +
        '3. Add that ID to Settings -> Telegram -> Allowed User IDs'
      );
    }

    this.bot = new Bot(botToken);
    this.chatTracker = new ChatTracker();

    this.setupMiddleware();
    this.setupHandlers();
  }

  /**
   * Set callback for when messages are received (for cross-channel sync)
   */
  setOnMessageCallback(callback: MessageCallback): void {
    this.onMessageCallback = callback;
  }

  /**
   * Set callback for when session links are created or removed (for UI refresh)
   */
  setOnSessionLinkCallback(callback: SessionLinkCallback): void {
    this.onSessionLinkCallback = callback;
  }

  /**
   * Setup bot middleware
   */
  private setupMiddleware(): void {
    // Tracking middleware (track active chat IDs)
    this.bot.use(createTrackingMiddleware(this.chatTracker));

    // Auth middleware (check user allowlist)
    this.bot.use(createAuthMiddleware());
  }

  /**
   * Setup all message handlers
   */
  private setupHandlers(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    // Command handler dependencies
    // Use getter so the callback is resolved at call-time, not at setup-time
    const commandDeps: CommandHandlerDeps = {
      bot: this.bot,
      get onSessionLinkCallback() { return self.onSessionLinkCallback; },
      sendResponse: this.sendResponse.bind(this),
    };

    // Callback handler dependencies
    const callbackDeps: CallbackHandlerDeps = {
      onMessageCallback: this.onMessageCallback,
      sendResponse: this.sendResponse.bind(this),
    };

    // Register command handlers
    registerCommandHandlers(commandDeps);
    registerSessionHandlers(commandDeps);

    // Register callback handler (for inline keyboards)
    registerCallbackHandler(this.bot, callbackDeps);

    // Register reaction handler
    const reactionHandler = createReactionHandler(async (chatId, messageId) => {
      // Handle negative reaction - offer clarification
      await this.bot.api.sendMessage(
        chatId,
        'I see you weren\'t satisfied with that response. Would you like me to:\n' +
        '* Try again with a different approach?\n' +
        '* Provide more detail?\n' +
        '* Explain my reasoning?',
        { reply_to_message_id: messageId }
      );
    });
    registerReactionHandler(this.bot, reactionHandler);

    // Document messages - register BEFORE text to ensure proper handling
    this.bot.on('message:document', async (ctx: Context) => {
      await handleDocumentMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Location messages - register BEFORE text to ensure proper handling
    this.bot.on('message:location', async (ctx: Context) => {
      await handleLocationMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Edited location (live location updates)
    this.bot.on('edited_message:location', async (ctx: Context) => {
      await handleEditedLocation(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Photo messages
    this.bot.on('message:photo', async (ctx: Context) => {
      await handlePhotoMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Voice messages
    this.bot.on('message:voice', async (ctx: Context) => {
      await handleVoiceMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Audio files
    this.bot.on('message:audio', async (ctx: Context) => {
      await handleAudioMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Text messages - register LAST as fallback
    this.bot.on('message:text', async (ctx: Context) => {
      await handleTextMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }

  /**
   * Send a response, splitting into multiple messages if needed
   * Converts markdown to Telegram HTML format
   */
  private async sendResponse(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000;

    if (text.length <= MAX_LENGTH) {
      const html = markdownToTelegramHtml(text);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch (error) {
        // Fallback to plain text if HTML parsing fails
        console.error('[Telegram] HTML parse failed, falling back to plain text:', error);
        await ctx.reply(text);
      }
      return;
    }

    const chunks = splitMessage(text, MAX_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
      const html = markdownToTelegramHtml(prefix + chunks[i]);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch {
        // Fallback to plain text if HTML parsing fails
        await ctx.reply(prefix + chunks[i]);
      }
      // Small delay between messages to maintain order
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Proactively send a message to a specific chat
   * Used by scheduler for cron jobs
   */
  async sendMessage(chatId: number, text: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot send message');
      return false;
    }

    try {
      const MAX_LENGTH = 4000;

      if (text.length <= MAX_LENGTH) {
        const html = markdownToTelegramHtml(text);
        try {
          await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          // Fallback to plain text
          await this.bot.api.sendMessage(chatId, text);
        }
      } else {
        const chunks = splitMessage(text, MAX_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
          const html = markdownToTelegramHtml(prefix + chunks[i]);
          try {
            await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
          } catch {
            await this.bot.api.sendMessage(chatId, prefix + chunks[i]);
          }
          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      console.log(`[Telegram] Sent proactive message to chat ${chatId}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to send message to chat ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send a message to all active chats (broadcast)
   */
  async broadcast(text: string): Promise<number> {
    let sent = 0;
    for (const chatId of this.chatTracker.getAll()) {
      const success = await this.sendMessage(chatId, text);
      if (success) sent++;
    }
    return sent;
  }

  /**
   * Send photos to a Telegram chat from local file paths
   */
  async sendPhotos(chatId: number, media: Array<{ type: string; filePath: string; mimeType: string }>): Promise<void> {
    for (const item of media) {
      if (item.type === 'image' && fs.existsSync(item.filePath)) {
        try {
          await this.bot.api.sendPhoto(chatId, new InputFile(item.filePath));
        } catch (err) {
          console.error(`[Telegram] Failed to send photo ${item.filePath}:`, err);
        }
      }
    }
  }

  /**
   * Send a response with optional media attachments
   */
  async sendResponseWithMedia(ctx: Context, text: string, media?: Array<{ type: string; filePath: string; mimeType: string }>): Promise<void> {
    await this.sendResponse(ctx, text);

    if (media && media.length > 0 && ctx.chat?.id) {
      await this.sendPhotos(ctx.chat.id, media);
    }
  }

  /**
   * Sync a desktop conversation to a specific Telegram chat
   */
  async syncToChat(userMessage: string, response: string, chatId: number, media?: Array<{ type: string; filePath: string; mimeType: string }>): Promise<boolean> {
    const text = `[Desktop]\n\nYou: ${userMessage}\n\nAssistant: ${response}`;
    const success = await this.sendMessage(chatId, text);

    // Send media photos if present
    if (success && media && media.length > 0) {
      await this.sendPhotos(chatId, media);
    }

    return success;
  }

  /**
   * Get list of active chat IDs
   */
  getActiveChatIds(): number[] {
    return this.chatTracker.getAll();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      console.error('[Telegram] No bot token configured');
      return;
    }

    try {
      this.bot.start({
        onStart: (botInfo) => {
          this.isRunning = true;
          try {
            console.log(`[Telegram] Bot @${botInfo.username} started`);
            console.log(`[Telegram] Authorized users: ${getAllowedUsers().join(', ')}`);
          } catch {
            // Ignore EPIPE errors from console.log
          }
        },
      });
    } catch (error) {
      console.error('[Telegram] Failed to start bot:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await this.bot.stop();
    this.isRunning = false;
    console.log('[Telegram] Bot stopped');
  }
}

// Singleton instance
let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  return telegramBotInstance;
}

export function createTelegramBot(): TelegramBot | null {
  if (!telegramBotInstance) {
    try {
      telegramBotInstance = new TelegramBot();
    } catch (error) {
      console.error('[Telegram] Failed to create bot:', error);
      return null;
    }
  }
  return telegramBotInstance;
}
