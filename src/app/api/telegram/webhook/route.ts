import { jsonError, jsonOk, isObjectRecord, methodNotAllowed } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import {
  createPairingCodeForTelegramUser,
  formatPairingCodeForTelegram,
  listPairingCodes,
  revokePairingCode
} from "@/lib/pairing";
import { sendTelegramMessage, formatDateForTelegram } from "@/lib/telegram";
import { upsertTelegramUserFromChat } from "@/lib/telegram-user";

export const runtime = "nodejs";
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(request: Request) {
  try {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");

    if (secret !== getServerEnv().TELEGRAM_WEBHOOK_SECRET) {
      return jsonError("Unauthorized", 401);
    }

    const update = await request.json().catch(() => null);
    const message = getTelegramMessage(update);

    if (!message) {
      return jsonOk({
        ok: true,
        ignored: true
      });
    }

    const telegramUser = await upsertTelegramUserFromChat({
      id: message.chat.id,
      username: message.chat.username ?? message.from?.username,
      first_name: message.chat.first_name ?? message.from?.first_name,
      last_name: message.chat.last_name ?? message.from?.last_name
    });

    const command = parseCommand(message.text);

    switch (command.name) {
      case "/start":
        await handleStart(message.chat.id, telegramUser.id);
        break;
      case "/help":
        await sendTelegramMessage(String(message.chat.id), helpText());
        break;
      case "/newcode":
        await handleNewCode(message.chat.id, telegramUser.id);
        break;
      case "/codes":
        await handleCodes(message.chat.id);
        break;
      case "/revoke":
        await handleRevoke(message.chat.id, command.args);
        break;
      default:
        await sendTelegramMessage(String(message.chat.id), "Неизвестная команда. Используйте /help.");
        break;
    }

    return jsonOk({
      ok: true
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Internal server error", 500);
  }
}

async function handleStart(chatId: number | string, telegramUserId: string): Promise<void> {
  const pairingCode = await createPairingCodeForTelegramUser(telegramUserId);

  await sendTelegramMessage(
    String(chatId),
    `Привет! Это Codex Telegram Notifier.

Ваш pairingCode:
${pairingCode.code}

Он действует 1 месяц.
Добавьте его в локальный конфиг Codex plugin.
Когда устройство подключится, этот код станет использованным.

Команды:
/newcode - создать новый pairingCode
/codes - список Ваших кодов
/revoke CODE - отозвать код
/help - справка`
  );
}

async function handleNewCode(chatId: number | string, telegramUserId: string): Promise<void> {
  const pairingCode = await createPairingCodeForTelegramUser(telegramUserId);

  await sendTelegramMessage(
    String(chatId),
    `Ваш новый pairingCode:
${pairingCode.code}

Истекает: ${formatDateForTelegram(pairingCode.expiresAt)}

Добавьте его в локальный конфиг Codex plugin. После подключения устройства код станет использованным.`
  );
}

async function handleCodes(chatId: number | string): Promise<void> {
  const codes = await listPairingCodes(String(chatId));

  if (codes.length === 0) {
    await sendTelegramMessage(String(chatId), "У Вас пока нет pairingCode. Используйте /newcode.");
    return;
  }

  const formattedCodes = codes
    .map((pairingCode, index) => {
      const formatted = formatPairingCodeForTelegram(pairingCode);
      return `${index + 1}. ${formatted}`;
    })
    .join("\n\n");

  await sendTelegramMessage(String(chatId), `Ваши pairingCode:\n\n${formattedCodes}`);
}

async function handleRevoke(chatId: number | string, args: string): Promise<void> {
  const code = args.trim().split(/\s+/)[0];

  if (!code) {
    await sendTelegramMessage(String(chatId), "Использование: /revoke ABCD-1234-EFGH");
    return;
  }

  const result = await revokePairingCode(String(chatId), code);
  await sendTelegramMessage(String(chatId), result.message);
}

function helpText(): string {
  return `Команды Codex Telegram Notifier:

/newcode - создать новый pairingCode
/codes - список Ваших кодов
/revoke CODE - отозвать активный pairingCode
/help - справка`;
}

function parseCommand(text: string): { name: string; args: string } {
  const trimmed = text.trim();
  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const commandWithoutBotName = rawCommand.split("@")[0]?.toLowerCase() ?? "";

  return {
    name: commandWithoutBotName,
    args: rest.join(" ")
  };
}

type TelegramMessage = {
  text: string;
  chat: {
    id: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  from?: {
    username?: string;
    first_name?: string;
    last_name?: string;
  };
};

function getTelegramMessage(update: unknown): TelegramMessage | null {
  if (!isObjectRecord(update) || !isObjectRecord(update.message)) {
    return null;
  }

  const message = update.message;

  if (typeof message.text !== "string" || !isObjectRecord(message.chat)) {
    return null;
  }

  const chat = message.chat;

  if (typeof chat.id !== "number" && typeof chat.id !== "string") {
    return null;
  }

  const from = isObjectRecord(message.from) ? message.from : undefined;

  return {
    text: message.text,
    chat: {
      id: chat.id,
      username: typeof chat.username === "string" ? chat.username : undefined,
      first_name: typeof chat.first_name === "string" ? chat.first_name : undefined,
      last_name: typeof chat.last_name === "string" ? chat.last_name : undefined
    },
    from: from
      ? {
          username: typeof from.username === "string" ? from.username : undefined,
          first_name: typeof from.first_name === "string" ? from.first_name : undefined,
          last_name: typeof from.last_name === "string" ? from.last_name : undefined
        }
      : undefined
  };
}
