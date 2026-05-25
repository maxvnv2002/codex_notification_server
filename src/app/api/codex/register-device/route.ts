import { PairingCodeStatus } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, formatZodError, methodNotAllowed } from "@/lib/api";
import { encryptSecret } from "@/lib/encryption";
import { expirePairingCodeAndNotify, normalizePairingCode } from "@/lib/pairing";
import { prisma } from "@/lib/prisma";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const registerDeviceSchema = z.object({
  pairingCode: z.string().min(5),
  deviceId: z.string().min(10),
  deviceName: z.string().min(1).max(100),
  deviceSecret: z.string().min(16)
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = registerDeviceSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Invalid request body", 400, formatZodError(parsed.error));
    }

    const input = {
      ...parsed.data,
      pairingCode: normalizePairingCode(parsed.data.pairingCode)
    };
    const now = new Date();

    const pairingCode = await prisma.pairingCode.findUnique({
      where: {
        code: input.pairingCode
      },
      include: {
        telegramUser: true
      }
    });

    if (!pairingCode) {
      return jsonError("Pairing code not found", 404);
    }

    if (pairingCode.status !== PairingCodeStatus.ACTIVE) {
      return jsonError(pairingCodeStatusError(pairingCode.status), 400);
    }

    if (pairingCode.expiresAt <= now) {
      await expirePairingCodeAndNotify(pairingCode.id);
      return jsonError("Pairing code expired", 400);
    }

    const existingDevice = await prisma.device.findUnique({
      where: {
        deviceId: input.deviceId
      }
    });

    if (existingDevice && existingDevice.telegramUserId !== pairingCode.telegramUserId) {
      return jsonError("Device ID is already registered to another Telegram user", 409);
    }

    const result = await prisma.$transaction(async (tx) => {
      if (existingDevice) {
        const device = await tx.device.update({
          where: {
            deviceId: input.deviceId
          },
          data: {
            deviceName: input.deviceName,
            lastSeenAt: now
          }
        });

        await tx.pairingCode.update({
          where: {
            id: pairingCode.id
          },
          data: {
            status: PairingCodeStatus.USED,
            usedAt: now
          }
        });

        return device;
      }

      const device = await tx.device.create({
        data: {
          telegramUserId: pairingCode.telegramUserId,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          deviceSecret: encryptSecret(input.deviceSecret),
          lastSeenAt: now
        }
      });

      await tx.pairingCode.update({
        where: {
          id: pairingCode.id
        },
        data: {
          status: PairingCodeStatus.USED,
          usedAt: now
        }
      });

      return device;
    });

    try {
      await sendTelegramMessage(
        pairingCode.telegramUser.telegramChatId,
        `Устройство ${input.deviceName} успешно подключено к Codex Telegram Notifier.`
      );
    } catch {
      // Registration is already committed; notification delivery can be retried by the user.
    }

    return jsonOk({
      ok: true,
      deviceId: result.deviceId,
      deviceName: result.deviceName
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Internal server error", 500);
  }
}

function pairingCodeStatusError(status: PairingCodeStatus): string {
  switch (status) {
    case PairingCodeStatus.USED:
      return "Pairing code has already been used";
    case PairingCodeStatus.REVOKED:
      return "Pairing code has been revoked";
    case PairingCodeStatus.EXPIRED:
      return "Pairing code expired";
    case PairingCodeStatus.ACTIVE:
      return "Pairing code is active";
  }
}
