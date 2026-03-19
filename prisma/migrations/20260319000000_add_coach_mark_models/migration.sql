-- CreateTable
CREATE TABLE "CoachMarkConversation" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachMarkConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachMarkMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachMarkMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoachMarkConversation_parentId_key" ON "CoachMarkConversation"("parentId");

-- CreateIndex
CREATE INDEX "CoachMarkConversation_parentId_idx" ON "CoachMarkConversation"("parentId");

-- CreateIndex
CREATE INDEX "CoachMarkMessage_conversationId_idx" ON "CoachMarkMessage"("conversationId");

-- CreateIndex
CREATE INDEX "CoachMarkMessage_conversationId_createdAt_idx" ON "CoachMarkMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "CoachMarkMessage" ADD CONSTRAINT "CoachMarkMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CoachMarkConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
