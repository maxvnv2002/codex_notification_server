import { jsonError, jsonOk, isObjectRecord, methodNotAllowed } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import {
  createPairingCodeForTelegramUser,
  formatPairingCodeForTelegram,
  listPairingCodes,
  listRevocablePairingCodes,
  revokePairingCode,
  revokePairingCodeById
} from "@/lib/pairing";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  formatDateForTelegram,
  sendTelegramMessage,
  TelegramApiError,
  type TelegramInlineKeyboardMarkup
} from "@/lib/telegram";
import { upsertTelegramUserFromChat } from "@/lib/telegram-user";

export const runtime = "nodejs";
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const CALLBACK_NEW_CODE = "menu:newcode";
const CALLBACK_CODES = "menu:codes";
const CALLBACK_REVOKE = "menu:revoke";
const CALLBACK_HELP = "menu:help";
const CALLBACK_REVOKE_PREFIX = "revoke:";

export async function POST(request: Request) {
  try {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");

    if (secret !== getServerEnv().TELEGRAM_WEBHOOK_SECRET) {
      return jsonError("Unauthorized", 401);
    }

    const update = await request.json().catch(() => null);
    const callbackQuery = getTelegramCallbackQuery(update);

    if (callbackQuery) {
      await handleCallbackQuery(callbackQuery);
      return jsonOk({
        ok: true
      });
    }

    const message = getTelegramMessage(update);

    if (!message) {
      return jsonOk({
        ok: true,
        ignored: true
      });
    }

    await handleMessage(message);

    return jsonOk({
      ok: true
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Internal server error", 500);
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const telegramUser = await upsertTelegramUser(message.chat, message.from);
  const command = parseCommand(message.text);

  switch (command.name) {
    case "/start":
      await handleStart(message.chat.id, telegramUser.id);
      break;
    case "/help":
      await sendTelegramMessage(String(message.chat.id), helpText(), {
        replyMarkup: mainMenuKeyboard()
      });
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
      await sendTelegramMessage(String(message.chat.id), "Неизвестная команда. Используйте /help.", {
        replyMarkup: mainMenuKeyboard()
      });
      break;
  }
}

async function handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
  let callbackAnswer = "";

  try {
    if (!callbackQuery.message) {
      callbackAnswer = "Не удалось определить сообщение.";
      return;
    }

    const chatId = String(callbackQuery.message.chat.id);
    const messageId = callbackQuery.message.message_id;
    const telegramUser = await upsertTelegramUser(callbackQuery.message.chat, callbackQuery.from);

    switch (callbackQuery.data) {
      case CALLBACK_NEW_CODE:
        await editNewCodeMessage(chatId, messageId, telegramUser.id);
        callbackAnswer = "Код создан";
        break;
      case CALLBACK_CODES:
        await editCodesMessage(chatId, messageId);
        break;
      case CALLBACK_REVOKE:
        await editRevokeSelectionMessage(chatId, messageId);
        break;
      case CALLBACK_HELP:
        await editOrSendMessage(chatId, messageId, helpText(), mainMenuKeyboard());
        break;
      default:
        if (callbackQuery.data.startsWith(CALLBACK_REVOKE_PREFIX)) {
          await editRevokeResultMessage(
            chatId,
            messageId,
            callbackQuery.data.slice(CALLBACK_REVOKE_PREFIX.length)
          );
        } else {
          callbackAnswer = "Неизвестное действие.";
          await editOrSendMessage(chatId, messageId, "Неизвестное действие. Используйте /help.", mainMenuKeyboard());
        }
        break;
    }
  } finally {
    await answerTelegramCallbackQuery(callbackQuery.id, callbackAnswer || undefined).catch(() => undefined);
  }
}

async function handleStart(chatId: number | string, telegramUserId: string): Promise<void> {
  const pairingCode = await createPairingCodeForTelegramUser(telegramUserId);

  await sendTelegramMessage(String(chatId), startText(pairingCode.code), {
    replyMarkup: mainMenuKeyboard()
  });
}

async function handleNewCode(chatId: number | string, telegramUserId: string): Promise<void> {
  const pairingCode = await createPairingCodeForTelegramUser(telegramUserId);

  await sendTelegramMessage(String(chatId), newCodeText(pairingCode.code, pairingCode.expiresAt), {
    replyMarkup: afterCodeKeyboard()
  });
}

async function editNewCodeMessage(
  chatId: string,
  messageId: number,
  telegramUserId: string
): Promise<void> {
  const pairingCode = await createPairingCodeForTelegramUser(telegramUserId);
  await editOrSendMessage(chatId, messageId, newCodeText(pairingCode.code, pairingCode.expiresAt), afterCodeKeyboard());
}

async function handleCodes(chatId: number | string): Promise<void> {
  await sendTelegramMessage(String(chatId), await codesText(String(chatId)), {
    replyMarkup: codesKeyboard()
  });
}

async function editCodesMessage(chatId: string, messageId: number): Promise<void> {
  await editOrSendMessage(chatId, messageId, await codesText(chatId), codesKeyboard());
}

async function handleRevoke(chatId: number | string, args: string): Promise<void> {
  const code = args.trim().split(/\s+/)[0];

  if (!code) {
    await sendTelegramMessage(String(chatId), await revokeSelectionText(String(chatId)), {
      replyMarkup: await revokeSelectionKeyboard(String(chatId))
    });
    return;
  }

  const result = await revokePairingCode(String(chatId), code);
  await sendTelegramMessage(String(chatId), result.message, {
    replyMarkup: revokeResultKeyboard()
  });
}

async function editRevokeSelectionMessage(chatId: string, messageId: number): Promise<void> {
  await editOrSendMessage(
    chatId,
    messageId,
    await revokeSelectionText(chatId),
    await revokeSelectionKeyboard(chatId)
  );
}

async function editRevokeResultMessage(
  chatId: string,
  messageId: number,
  pairingCodeId: string
): Promise<void> {
  const result = await revokePairingCodeById(chatId, pairingCodeId);
  await editOrSendMessage(chatId, messageId, result.message, revokeResultKeyboard());
}

async function codesText(chatId: string): Promise<string> {
  const codes = await listPairingCodes(chatId);

  if (codes.length === 0) {
    return "У Вас пока нет pairingCode. Используйте кнопку «Новый код».";
  }

  const formattedCodes = codes
    .map((pairingCode, index) => {
      const formatted = formatPairingCodeForTelegram(pairingCode);
      return `${index + 1}. ${formatted}`;
    })
    .join("\n\n");

  return `Ваши pairingCode:\n\n${formattedCodes}`;
}

async function revokeSelectionText(chatId: string): Promise<string> {
  const codes = await listRevocablePairingCodes(chatId);

  if (codes.length === 0) {
    return "Нет активных pairingCode, которые можно отозвать.";
  }

  return "Выберите код, который хотите отозвать:";
}

async function revokeSelectionKeyboard(chatId: string): Promise<TelegramInlineKeyboardMarkup> {
  const codes = await listRevocablePairingCodes(chatId);

  if (codes.length === 0) {
    return noRevocableCodesKeyboard();
  }

  return {
    inline_keyboard: [
      ...codes.map((pairingCode) => [
        {
          text: pairingCode.code,
          callback_data: `${CALLBACK_REVOKE_PREFIX}${pairingCode.id}`
        }
      ]),
      [
        {
          text: "Мои коды",
          callback_data: CALLBACK_CODES
        },
        {
          text: "Новый код",
          callback_data: CALLBACK_NEW_CODE
        }
      ],
      [
        {
          text: "Помощь",
          callback_data: CALLBACK_HELP
        }
      ]
    ]
  };
}

async function editOrSendMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup
): Promise<void> {
  try {
    await editTelegramMessageText(chatId, messageId, text, {
      replyMarkup
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    await sendTelegramMessage(chatId, text, {
      replyMarkup
    });
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    typeof error.description === "string" &&
    error.description.toLowerCase().includes("message is not modified")
  );
}

async function upsertTelegramUser(
  chat: TelegramChat,
  from?: TelegramFrom
): ReturnType<typeof upsertTelegramUserFromChat> {
  return upsertTelegramUserFromChat({
    id: chat.id,
    username: chat.username ?? from?.username,
    first_name: chat.first_name ?? from?.first_name,
    last_name: chat.last_name ?? from?.last_name
  });
}

function startText(code: string): string {
  return `Привет! Это Codex Telegram Notifier.

Ваш pairingCode:
${code}

Он действует 1 месяц.
Добавьте его в Codex plugin через /notifier_start CODE.
Когда устройство подключится, этот код станет использованным.`;
}

function newCodeText(code: string, expiresAt: Date): string {
  return `Ваш новый pairingCode:
${code}

Истекает: ${formatDateForTelegram(expiresAt)}

Добавьте его в Codex plugin через /notifier_start CODE. После подключения устройства код станет использованным.`;
}

function helpText(): string {
  return `Codex Telegram Notifier

Команды бота:
/newcode - создать новый pairingCode
/codes - список Ваших кодов
/revoke CODE - отозвать активный pairingCode
/help - справка

Установка плагина в Codex:
\`\`\`
codex plugin marketplace add https://github.com/maxvnv2002/codex_telegram_notifier_plugin.git
codex plugin add codex-telegram-notifier@codex-telegram-notifier
\`\`\`

После установки:
1. Перезапустите Codex.
2. Получите pairingCode кнопкой «Новый код» или командой /newcode.
3. В Codex выполните /notifier_start CODE.

После подключения уведомления будут приходить в этот Telegram-чат.`;
}

function mainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Новый код",
          callback_data: CALLBACK_NEW_CODE
        },
        {
          text: "Мои коды",
          callback_data: CALLBACK_CODES
        }
      ],
      [
        {
          text: "Отозвать",
          callback_data: CALLBACK_REVOKE
        },
        {
          text: "Помощь",
          callback_data: CALLBACK_HELP
        }
      ]
    ]
  };
}

function afterCodeKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Мои коды",
          callback_data: CALLBACK_CODES
        },
        {
          text: "Отозвать",
          callback_data: CALLBACK_REVOKE
        }
      ],
      [
        {
          text: "Помощь",
          callback_data: CALLBACK_HELP
        }
      ]
    ]
  };
}

function codesKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Новый код",
          callback_data: CALLBACK_NEW_CODE
        },
        {
          text: "Отозвать",
          callback_data: CALLBACK_REVOKE
        }
      ],
      [
        {
          text: "Помощь",
          callback_data: CALLBACK_HELP
        }
      ]
    ]
  };
}

function revokeResultKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Отозвать еще",
          callback_data: CALLBACK_REVOKE
        }
      ],
      [
        {
          text: "Мои коды",
          callback_data: CALLBACK_CODES
        },
        {
          text: "Новый код",
          callback_data: CALLBACK_NEW_CODE
        }
      ]
    ]
  };
}

function noRevocableCodesKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Мои коды",
          callback_data: CALLBACK_CODES
        },
        {
          text: "Новый код",
          callback_data: CALLBACK_NEW_CODE
        }
      ],
      [
        {
          text: "Помощь",
          callback_data: CALLBACK_HELP
        }
      ]
    ]
  };
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

type TelegramChat = {
  id: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramFrom = {
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  text: string;
  chat: TelegramChat;
  from?: TelegramFrom;
};

type TelegramCallbackQuery = {
  id: string;
  data: string;
  from?: TelegramFrom;
  message?: {
    message_id: number;
    chat: TelegramChat;
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

  const chat = getTelegramChat(message.chat);
  if (!chat) {
    return null;
  }

  const from = getTelegramFrom(message.from);

  return {
    text: message.text,
    chat,
    from
  };
}

function getTelegramCallbackQuery(update: unknown): TelegramCallbackQuery | null {
  if (!isObjectRecord(update) || !isObjectRecord(update.callback_query)) {
    return null;
  }

  const callbackQuery = update.callback_query;

  if (typeof callbackQuery.id !== "string") {
    return null;
  }

  const message = isObjectRecord(callbackQuery.message) ? callbackQuery.message : undefined;
  const chat = message && isObjectRecord(message.chat) ? getTelegramChat(message.chat) : null;
  const messageId = message?.message_id;
  const from = getTelegramFrom(callbackQuery.from);

  return {
    id: callbackQuery.id,
    data: typeof callbackQuery.data === "string" ? callbackQuery.data : "",
    from,
    message:
      chat && typeof messageId === "number"
        ? {
            message_id: messageId,
            chat
          }
        : undefined
  };
}

function getTelegramChat(value: unknown): TelegramChat | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (typeof value.id !== "number" && typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    username: typeof value.username === "string" ? value.username : undefined,
    first_name: typeof value.first_name === "string" ? value.first_name : undefined,
    last_name: typeof value.last_name === "string" ? value.last_name : undefined
  };
}

function getTelegramFrom(value: unknown): TelegramFrom | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  return {
    username: typeof value.username === "string" ? value.username : undefined,
    first_name: typeof value.first_name === "string" ? value.first_name : undefined,
    last_name: typeof value.last_name === "string" ? value.last_name : undefined
  };
}
