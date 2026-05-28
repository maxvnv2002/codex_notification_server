import { getServerEnv } from "@/lib/env";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_REQUEST_TIMEOUT_MS = 8000;

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
};

type SendTelegramMessageOptions = {
  parseMode?: "HTML";
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
  const { TELEGRAM_BOT_TOKEN } = getServerEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  let response: Response;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: limitTelegramText(text),
    disable_web_page_preview: true
  };

  if (options.parseMode) {
    body.parse_mode = options.parseMode;
  }

  try {
    response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TelegramApiError(
        `Telegram API sendMessage timed out after ${TELEGRAM_REQUEST_TIMEOUT_MS}ms`
      );
    }

    throw new TelegramApiError(
      `Telegram API sendMessage failed: ${error instanceof Error ? error.message : "network error"}`
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
      `Telegram API sendMessage failed: ${payload?.description ?? response.statusText}`,
      response.status,
      payload?.description
    );
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
