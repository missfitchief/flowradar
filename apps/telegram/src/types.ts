export interface TelegramUser { id: number; username?: string; }
export interface TelegramChat { id: number; type: string; }
export interface TelegramMessage { message_id: number; from?: TelegramUser; chat: TelegramChat; text?: string; reply_markup?: InlineKeyboard; }
export interface TelegramCallbackQuery { id: string; from: TelegramUser; message?: TelegramMessage; data?: string; }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery; }
export interface InlineButton { text: string; callback_data?: string; url?: string; copy_text?: { text: string }; }
export interface InlineKeyboard { inline_keyboard: InlineButton[][]; }

export interface TelegramApi {
  getMe(): Promise<{ id: number; username?: string }>;
  deleteWebhook(): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  getUpdates(offset: bigint, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<TelegramMessage>;
  editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendDocument(chatId: string, filename: string, content: string, mimeType: string, caption?: string): Promise<void>;
}
