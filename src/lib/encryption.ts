import crypto from "node:crypto";
import { getAppEncryptionKey } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getAppEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export function decryptSecret(encryptedSecret: string): string {
  const [version, ivBase64, authTagBase64, encryptedBase64] = encryptedSecret.split(":");

  if (version !== VERSION || !ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getAppEncryptionKey(),
    Buffer.from(ivBase64, "base64")
  );

  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]).toString("utf8");
}
