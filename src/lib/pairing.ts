import crypto from "node:crypto";
import { PairingCodeStatus, Prisma, type PairingCode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatDateForTelegram, sendTelegramMessage } from "@/lib/telegram";

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 12;
const PAIRING_CODE_MAX_ATTEMPTS = 8;
const PAIRING_CODE_LIST_LIMIT = 20;

export type RevokePairingCodeResult = {
  ok: boolean;
  message: string;
};

export type ExpirePairingCodesResult = {
  expiredCount: number;
  notifiedCount: number;
  failedNotificationCount: number;
};

export function generatePairingCode(): string {
  const randomBytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  const chars = Array.from(randomBytes, (byte) => {
    return PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
  });

  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
    .slice(8, 12)
    .join("")}`;
}

export async function createPairingCodeForTelegramUser(
  telegramUserId: string
): Promise<PairingCode> {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.pairingCode.create({
        data: {
          telegramUserId,
          code: generatePairingCode(),
          status: PairingCodeStatus.ACTIVE,
          expiresAt
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < PAIRING_CODE_MAX_ATTEMPTS - 1) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to create unique pairing code");
}

export async function expirePairingCodes(): Promise<ExpirePairingCodesResult> {
  const now = new Date();
  const candidates = await prisma.pairingCode.findMany({
    where: {
      expirationNotifiedAt: null,
      OR: [
        {
          status: PairingCodeStatus.ACTIVE,
          expiresAt: {
            lte: now
          }
        },
        {
          status: PairingCodeStatus.EXPIRED
        }
      ]
    },
    include: {
      telegramUser: true
    }
  });

  let expiredCount = 0;
  let notifiedCount = 0;
  let failedNotificationCount = 0;

  for (const pairingCode of candidates) {
    if (pairingCode.status === PairingCodeStatus.ACTIVE) {
      await prisma.pairingCode.update({
        where: {
          id: pairingCode.id
        },
        data: {
          status: PairingCodeStatus.EXPIRED
        }
      });
      expiredCount += 1;
    }

    try {
      await sendPairingCodeExpiredMessage(pairingCode.telegramUser.telegramChatId, pairingCode.code);
      await prisma.pairingCode.update({
        where: {
          id: pairingCode.id
        },
        data: {
          expirationNotifiedAt: new Date()
        }
      });
      notifiedCount += 1;
    } catch {
      failedNotificationCount += 1;
    }
  }

  return {
    expiredCount,
    notifiedCount,
    failedNotificationCount
  };
}

export async function expirePairingCodeAndNotify(pairingCodeId: string): Promise<boolean> {
  const pairingCode = await prisma.pairingCode.update({
    where: {
      id: pairingCodeId
    },
    data: {
      status: PairingCodeStatus.EXPIRED
    },
    include: {
      telegramUser: true
    }
  });

  if (pairingCode.expirationNotifiedAt) {
    return true;
  }

  try {
    await sendPairingCodeExpiredMessage(pairingCode.telegramUser.telegramChatId, pairingCode.code);
    await prisma.pairingCode.update({
      where: {
        id: pairingCode.id
      },
      data: {
        expirationNotifiedAt: new Date()
      }
    });
    return true;
  } catch {
    return false;
  }
}

export async function revokePairingCode(
  telegramChatId: string,
  code: string
): Promise<RevokePairingCodeResult> {
  const pairingCode = await prisma.pairingCode.findFirst({
    where: {
      code: normalizePairingCode(code),
      telegramUser: {
        telegramChatId
      }
    }
  });

  if (!pairingCode) {
    return {
      ok: false,
      message: "Код не найден среди Ваших pairingCode."
    };
  }

  if (pairingCode.status === PairingCodeStatus.USED) {
    return {
      ok: false,
      message:
        "Этот pairingCode уже использован. Он не может быть повторно использован. Если нужно отключить устройство, это будет отдельная команда в будущей версии."
    };
  }

  if (pairingCode.status === PairingCodeStatus.EXPIRED) {
    return {
      ok: false,
      message: "Этот pairingCode уже истек."
    };
  }

  if (pairingCode.status === PairingCodeStatus.REVOKED) {
    return {
      ok: false,
      message: "Этот pairingCode уже был отозван."
    };
  }

  await prisma.pairingCode.update({
    where: {
      id: pairingCode.id
    },
    data: {
      status: PairingCodeStatus.REVOKED,
      revokedAt: new Date()
    }
  });

  return {
    ok: true,
    message: `PairingCode ${pairingCode.code} отозван.`
  };
}

export async function listPairingCodes(telegramChatId: string): Promise<PairingCode[]> {
  return prisma.pairingCode.findMany({
    where: {
      telegramUser: {
        telegramChatId
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    take: PAIRING_CODE_LIST_LIMIT
  });
}

export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function formatPairingCodeForTelegram(pairingCode: PairingCode): string {
  const lines = [
    pairingCode.code,
    `Статус: ${pairingCode.status}`,
    `Создан: ${formatDateForTelegram(pairingCode.createdAt)}`,
    `Истекает: ${formatDateForTelegram(pairingCode.expiresAt)}`
  ];

  if (pairingCode.usedAt) {
    lines.push(`Использован: ${formatDateForTelegram(pairingCode.usedAt)}`);
  }

  if (pairingCode.revokedAt) {
    lines.push(`Отозван: ${formatDateForTelegram(pairingCode.revokedAt)}`);
  }

  return lines.join("\n");
}

async function sendPairingCodeExpiredMessage(chatId: string, code: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `Ваш pairingCode ${code} истек и больше не может быть использован. Вы можете создать новый код командой /newcode.`
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
