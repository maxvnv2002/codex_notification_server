import type { TelegramUser } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type TelegramChatInput = {
  id: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export async function upsertTelegramUserFromChat(chat: TelegramChatInput): Promise<TelegramUser> {
  return prisma.telegramUser.upsert({
    where: {
      telegramChatId: String(chat.id)
    },
    create: {
      telegramChatId: String(chat.id),
      username: chat.username ?? null,
      firstName: chat.first_name ?? null,
      lastName: chat.last_name ?? null
    },
    update: {
      username: chat.username ?? null,
      firstName: chat.first_name ?? null,
      lastName: chat.last_name ?? null
    }
  });
}
