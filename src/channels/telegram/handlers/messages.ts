/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { findWorkflowCommand } from '../../../config/commands-loader';

export interface MessageHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Handle incoming text messages
 */
export async function handleTextMessage(
  ctx: Context,
  deps: MessageHandlerDeps
): Promise<void> {
  const message = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!message || !chatId) return;

  const { onMessageCallback, sendResponse } = deps;

  // Check if this is a workflow slash command (e.g., /create-workflow some context)
  let fullMessage = message;
  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const commandName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, ''); // Strip @botname suffix
    const userText = spaceIdx !== -1 ? message.substring(spaceIdx + 1).trim() : '';
    const workflow = findWorkflowCommand(commandName);

    if (workflow) {
      fullMessage = `[Workflow: ${workflow.name}]\n${workflow.content}\n[/Workflow]`;
      if (userText) fullMessage += `\n\n${userText}`;
    }
  }

  try {
    const result = await withTyping(ctx, async () => {
      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return AgentManager.processMessage(fullMessage, 'telegram', sessionId);
    });

    // Send response, splitting if necessary
    await sendResponse(ctx, result.response);

    // Send media photos if present
    if (result.media && result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.media);
      }
    }

    // Notify callback for cross-channel sync (to desktop)
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      onMessageCallback({
        userMessage: message,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        wasCompacted: result.wasCompacted,
        media: result.media,
      });
    }

    // If compaction happened, notify
    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`⚠️ ${errorMsg}`);
  }
}
