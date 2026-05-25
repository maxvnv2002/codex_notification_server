import { z } from "zod";

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    CRON_SECRET: z.string().min(1),
    APP_ENCRYPTION_KEY: z.string().min(1)
  })
  .superRefine((env, ctx) => {
    const key = Buffer.from(env.APP_ENCRYPTION_KEY, "base64");

    if (key.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_ENCRYPTION_KEY"],
        message: "must be a base64 string that decodes to exactly 32 bytes"
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | null = null;
let cachedEncryptionKey: Buffer | null = null;

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid server environment: ${details}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getAppEncryptionKey(): Buffer {
  if (cachedEncryptionKey) {
    return cachedEncryptionKey;
  }

  cachedEncryptionKey = Buffer.from(getServerEnv().APP_ENCRYPTION_KEY, "base64");
  return cachedEncryptionKey;
}
