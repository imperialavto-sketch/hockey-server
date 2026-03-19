-- CreateTable
CREATE TABLE "TrainingEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingEvent_teamId_idx" ON "TrainingEvent"("teamId");

-- CreateIndex
CREATE INDEX "TrainingEvent_startTime_idx" ON "TrainingEvent"("startTime");

