import { Prisma } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, formatZodError, methodNotAllowed } from "@/lib/api";
import { decryptSecret } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { isTimestampWithinSkew, verifyHmacSignature } from "@/lib/signature";
import { limitTelegramText, sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const nullableString = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

const notifySchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  projectName: nullableString(200),
  gitBranch: nullableString(200),
  codexSessionId: nullableString(200),
  codexTurnId: nullableString(200),
  model: nullableString(100),
  finishedAt: z.string().datetime().optional().nullable(),
  message: z.string().min(1).max(20000)
});

export async function POST(request: Request) {
  try {
    const headerDeviceId = request.headers.get("x-codex-device-id");
    const receivedSignature = request.headers.get("x-codex-signature");
    const timestamp = request.headers.get("x-codex-timestamp");

    if (!headerDeviceId) {
      return jsonError("Missing x-codex-device-id header", 401);
    }

    if (!timestamp) {
      return jsonError("Missing x-codex-timestamp header", 401);
    }

    if (!receivedSignature) {
      return jsonError("Missing x-codex-signature header", 401);
    }

    if (!isTimestampWithinSkew(timestamp)) {
      return jsonError("Request timestamp is outside the allowed 5 minute window", 401);
    }

    const rawBody = await request.text();
    const json = parseJson(rawBody);
    const parsed = notifySchema.safeParse(json);

    if (!parsed.success) {
      return jsonError("Invalid request body", 400, formatZodError(parsed.error));
    }

    const input = parsed.data;

    if (input.deviceId !== headerDeviceId) {
      return jsonError("Body deviceId does not match x-codex-device-id", 401);
    }

    const device = await prisma.device.findUnique({
      where: {
        deviceId: headerDeviceId
      },
      include: {
        telegramUser: true
      }
    });

    if (!device) {
      return jsonError("Device not found", 404);
    }

    if (device.revokedAt) {
      return jsonError("Device is revoked", 403);
    }

    const deviceSecret = decryptSecret(device.deviceSecret);
    const signatureOk = verifyHmacSignature({
      timestamp,
      rawBody,
      secret: deviceSecret,
      receivedSignature
    });

    if (!signatureOk) {
      return jsonError("Invalid request signature", 401);
    }

    if (input.codexSessionId && input.codexTurnId) {
      const existingLog = await prisma.notificationLog.findFirst({
        where: {
          deviceId: headerDeviceId,
          codexSessionId: input.codexSessionId,
          codexTurnId: input.codexTurnId
        }
      });

      if (existingLog) {
        return jsonOk({
          ok: true,
          duplicate: true
        });
      }
    }

    const telegramText = buildNotificationText(input);
    await sendTelegramMessage(device.telegramUser.telegramChatId, telegramText);

    try {
      await prisma.$transaction([
        prisma.notificationLog.create({
          data: {
            deviceId: headerDeviceId,
            codexSessionId: input.codexSessionId,
            codexTurnId: input.codexTurnId,
            projectName: input.projectName,
            gitBranch: input.gitBranch,
            message: input.message
          }
        }),
        prisma.device.update({
          where: {
            deviceId: headerDeviceId
          },
          data: {
            lastSeenAt: new Date()
          }
        })
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return jsonOk({
          ok: true,
          duplicate: true
        });
      }

      throw error;
    }

    return jsonOk({
      ok: true
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Internal server error", 500);
  }
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function buildNotificationText(input: z.infer<typeof notifySchema>): string {
  return limitTelegramText(`Codex завершил работу

Проект: ${input.projectName ?? "unknown"}
Ветка: ${input.gitBranch ?? "unknown"}
Устройство: ${input.deviceName}
Модель: ${input.model ?? "unknown"}
Session: ${input.codexSessionId ?? "unknown"}
Turn: ${input.codexTurnId ?? "unknown"}

Итог:
${input.message}`);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
