import { getServerEnv } from "@/lib/env";

const TELEGRAM_TEXT_LIMIT = 4096;

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
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

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const { TELEGRAM_BOT_TOKEN } = getServerEnv();
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: limitTelegramText(text),
        disable_web_page_preview: true
      })
    }
  );

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

export function formatDateForTelegram(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Moscow"
  }).format(date);
}
