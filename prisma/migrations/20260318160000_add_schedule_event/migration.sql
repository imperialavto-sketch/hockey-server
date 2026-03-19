-- CreateTable
CREATE TABLE "ScheduleEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleEvent_teamId_idx" ON "ScheduleEvent"("teamId");

-- CreateIndex
CREATE INDEX "ScheduleEvent_startTime_idx" ON "ScheduleEvent"("startTime");

