import { NotificationEventType, Prisma } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, formatZodError, methodNotAllowed } from "@/lib/api";
import { decryptSecret } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { isTimestampWithinSkew, verifyHmacSignature } from "@/lib/signature";
import { escapeTelegramHtml, limitTelegramText, sendTelegramMessage } from "@/lib/telegram";

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
  eventType: z.enum(["completed", "waiting_for_input"]).default("completed"),
  responseOptions: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .nullable()
    .transform((value) => value ?? []),
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
    const eventType = toNotificationEventType(input.eventType);

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
          codexTurnId: input.codexTurnId,
          eventType
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
    await sendTelegramMessage(device.telegramUser.telegramChatId, telegramText, {
      parseMode: "HTML"
    });

    try {
      await prisma.$transaction([
        prisma.notificationLog.create({
          data: {
            deviceId: headerDeviceId,
            eventType,
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
  const status =
    input.eventType === "waiting_for_input" ? "Ожидает ответ" : "Завершил работу";
  const options = input.responseOptions
    .slice(0, 10)
    .map((option, index) => `${index + 1}. ${escapeTelegramHtml(limitDisplayText(option, 180))}`)
    .join("\n");
  const optionsBlock = options ? `\n\n<b>Варианты ответа</b>\n${options}` : "";
  const header = `<b>Codex: ${status}</b>

<b>Проект:</b> ${escapeTelegramHtml(limitDisplayText(input.projectName ?? "unknown", 120))}
<b>Ветка:</b> ${escapeTelegramHtml(limitDisplayText(input.gitBranch ?? "unknown", 120))}
<b>Устройство:</b> ${escapeTelegramHtml(limitDisplayText(input.deviceName, 100))}
${optionsBlock}

<b>Итог</b>
<pre>`;
  const footer = "</pre>";
  const message = limitHtmlPreText(input.message, header, footer);

  return limitTelegramText(`${header}${message}${footer}`);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function toNotificationEventType(eventType: z.infer<typeof notifySchema>["eventType"]) {
  return eventType === "waiting_for_input"
    ? NotificationEventType.WAITING_FOR_INPUT
    : NotificationEventType.COMPLETED;
}

function limitHtmlPreText(value: string, header: string, footer: string): string {
  const suffix = "\n...[truncated]";
  let remaining = value;

  while (remaining.length > 0) {
    const escaped = escapeTelegramHtml(remaining);
    if (`${header}${escaped}${footer}`.length <= 4096) {
      return escaped;
    }

    const nextLength = Math.max(0, Math.floor(remaining.length * 0.8) - suffix.length);
    remaining = `${remaining.slice(0, nextLength)}${suffix}`;
  }

  return "";
}

function limitDisplayText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
