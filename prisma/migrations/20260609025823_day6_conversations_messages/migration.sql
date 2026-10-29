-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('email');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'replied', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('out', 'in');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT,
    "integrationId" TEXT,
    "channel" "ConversationChannel" NOT NULL DEFAULT 'email',
    "threadRef" TEXT,
    "subject" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "fromAddress" TEXT,
    "externalId" TEXT,
    "draftId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_orgId_idx" ON "conversations"("orgId");

-- CreateIndex
CREATE INDEX "conversations_orgId_status_idx" ON "conversations"("orgId", "status");

-- CreateIndex
CREATE INDEX "conversations_orgId_contactId_idx" ON "conversations"("orgId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_orgId_threadRef_key" ON "conversations"("orgId", "threadRef");

-- CreateIndex
CREATE INDEX "messages_conversationId_sentAt_idx" ON "messages"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "messages_orgId_externalId_key" ON "messages"("orgId", "externalId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
