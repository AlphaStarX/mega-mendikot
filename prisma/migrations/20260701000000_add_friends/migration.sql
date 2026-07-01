-- Mega Mindikot 5v5 — Phase 6: friends list.
-- Creates the Friendship table — the first relational table in this DB (every
-- prior migration only added columns to User). One row per ordered pair:
-- userId = requester, friendId = recipient, status pending until accepted.
-- Both FKs cascade on user delete, so deleting an account severs their edges.
-- Additive + idempotent-style; applies on container boot (migrate deploy).

-- CreateTable
CREATE TABLE "Friendship" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one request per ordered (userId, friendId) pair
CREATE UNIQUE INDEX "Friendship_userId_friendId_key" ON "Friendship"("userId", "friendId");
-- CreateIndex — backs "my friends" / "outgoing requests" lookups
CREATE INDEX "Friendship_userId_status_idx" ON "Friendship"("userId", "status");
-- CreateIndex — backs "incoming requests" lookups
CREATE INDEX "Friendship_friendId_status_idx" ON "Friendship"("friendId", "status");

-- AddForeignKey — the first FKs in the schema. CASCADE so deleting a user
-- removes their friendship edges on both sides.
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
