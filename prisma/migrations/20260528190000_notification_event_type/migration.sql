-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('COMPLETED', 'WAITING_FOR_INPUT');

-- AlterTable
ALTER TABLE "NotificationLog"
ADD COLUMN "eventType" "NotificationEventType" NOT NULL DEFAULT 'COMPLETED';

-- Replace old notification deduplication index with event-aware deduplication.
DROP INDEX "NotificationLog_deviceId_codexSessionId_codexTurnId_key";

CREATE UNIQUE INDEX "NotificationLog_dedupe_event_key"
ON "NotificationLog"("deviceId", "codexSessionId", "codexTurnId", "eventType");
