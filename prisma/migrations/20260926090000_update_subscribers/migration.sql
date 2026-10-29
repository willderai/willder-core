-- Launch-update signups from the public landing page (double opt-in). A new,
-- self-contained table: no foreign keys and no change to any existing row.

CREATE TABLE "update_subscribers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "sourcePage" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "tokenHash" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "confirmationSentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "mirroredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "update_subscribers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "update_subscribers_email_key" ON "update_subscribers"("email");
CREATE UNIQUE INDEX "update_subscribers_tokenHash_key" ON "update_subscribers"("tokenHash");
