import crypto from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export function createHmacSignature({
  timestamp,
  rawBody,
  secret
}: {
  timestamp: string;
  rawBody: string;
  secret: string;
}): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyHmacSignature({
  timestamp,
  rawBody,
  secret,
  receivedSignature
}: {
  timestamp: string;
  rawBody: string;
  secret: string;
  receivedSignature: string;
}): boolean {
  if (!receivedSignature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expectedSignature = createHmacSignature({ timestamp, rawBody, secret });
  const expected = Buffer.from(expectedSignature, "utf8");
  const received = Buffer.from(receivedSignature, "utf8");

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

export function isTimestampWithinSkew(timestamp: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampMs = Number(timestamp);

  if (!Number.isSafeInteger(timestampMs)) {
    return false;
  }

  return Math.abs(now - timestampMs) <= MAX_TIMESTAMP_SKEW_MS;
}
