-- CreateTable
CREATE TABLE "ParentAuthCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParentAuthCode_phone_code_idx" ON "ParentAuthCode"("phone", "code");

