-- The landing page's live viewer count: one row per open tab, keyed by a random id the tab
-- makes for itself (services/presence/landing-presence.ts). Holds no IP, user agent, cookie
-- or account; a row lives at most the 60-second counting window, since every heartbeat
-- deletes the rows older than that.
--
-- Additive: one new table and its index; no existing row, column or index changes.

-- CreateTable
CREATE TABLE "landing_presence" (
    "tabId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_presence_pkey" PRIMARY KEY ("tabId")
);

-- The count and the prune both read a range of lastSeenAt.
CREATE INDEX "landing_presence_lastSeenAt_idx" ON "landing_presence"("lastSeenAt");
