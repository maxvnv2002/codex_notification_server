import { getServerEnv } from "@/lib/env";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_REQUEST_TIMEOUT_MS = 8000;

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
};

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

type SendTelegramMessageOptions = {
  parseMode?: "HTML";
  replyMarkup?: TelegramInlineKeyboardMarkup;
};

type EditTelegramMessageOptions = {
  parseMode?: "HTML";
  replyMarkup?: TelegramInlineKeyboardMarkup;
};

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly description?: string
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function limitTelegramText(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) {
    return text;
  }

  return text.slice(0, TELEGRAM_TEXT_LIMIT - 1) + "…";
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options: SendTelegramMessageOptions = {}
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: limitTelegramText(text),
    disable_web_page_preview: true
  };

  applyTelegramMessageOptions(body, options);

  await telegramApiRequest("sendMessage", body);
}

export async function editTelegramMessageText(
  chatId: string,
  messageId: number,
  text: string,
  options: EditTelegramMessageOptions = {}
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: limitTelegramText(text),
    disable_web_page_preview: true
  };

  applyTelegramMessageOptions(body, options);

  await telegramApiRequest("editMessageText", body);
}

export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  };

  if (text) {
    body.text = text;
  }

  await telegramApiRequest("answerCallbackQuery", body);
}

async function telegramApiRequest(method: string, body: Record<string, unknown>): Promise<void> {
  const { TELEGRAM_BOT_TOKEN } = getServerEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TelegramApiError(`Telegram API ${method} timed out after ${TELEGRAM_REQUEST_TIMEOUT_MS}ms`);
    }

    throw new TelegramApiError(
      `Telegram API ${method} failed: ${error instanceof Error ? error.message : "network error"}`
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload: TelegramApiResponse | null = null;

  try {
    payload = (await response.json()) as TelegramApiResponse;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    throw new TelegramApiError(
      `Telegram API ${method} failed: ${payload?.description ?? response.statusText}`,
      response.status,
      payload?.description
    );
  }
}

function applyTelegramMessageOptions(
  body: Record<string, unknown>,
  options: SendTelegramMessageOptions | EditTelegramMessageOptions
): void {
  if (options.parseMode) {
    body.parse_mode = options.parseMode;
  }

  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatDateForTelegram(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Moscow"
  }).format(date);
}
