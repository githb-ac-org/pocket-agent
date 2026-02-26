/**
 * Telegram inline keyboard builder
 * Creates inline keyboards for interactive messages
 */

import { InlineKeyboard } from 'grammy';
import { InlineKeyboardButton, InlineKeyboardRow } from '../types';

/**
 * Builder for Telegram inline keyboards
 */
export class InlineKeyboardBuilder {
  private rows: InlineKeyboardRow[] = [];

  /**
   * Add a row of buttons
   */
  addRow(buttons: InlineKeyboardButton[]): this {
    this.rows.push(buttons);
    return this;
  }

  /**
   * Add a single button as its own row
   */
  addButton(text: string, callbackData: string): this {
    this.rows.push([{ text, callbackData }]);
    return this;
  }

  /**
   * Build the grammy InlineKeyboard
   */
  build(): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const row of this.rows) {
      for (const button of row) {
        keyboard.text(button.text, button.callbackData);
      }
      keyboard.row();
    }

    return keyboard;
  }

  /**
   * Clear all buttons
   */
  clear(): this {
    this.rows = [];
    return this;
  }

  /**
   * Check if keyboard has any buttons
   */
  isEmpty(): boolean {
    return this.rows.length === 0;
  }
}


