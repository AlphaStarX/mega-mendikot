-- Mega Mindikot 5v5 — Phase 4: player identity (player IDs, avatars, country flags).
-- Adds three nullable columns to User + an index on playerId for the future
-- "add friend by ID" lookup (Phase 6). All nullable so existing rows are safe;
-- playerId is backfilled lazily on each user's next login (see handleSignup/
-- handleLogin in server/index.js). Additive; non-locking at this scale.

-- AddColumns
ALTER TABLE "User" ADD COLUMN "playerId" TEXT;
ALTER TABLE "User" ADD COLUMN "country"  TEXT;
ALTER TABLE "User" ADD COLUMN "avatar"   TEXT;

-- CreateIndex (unique — generated codes must not collide; lazy backfill retries on conflict)
CREATE UNIQUE INDEX "User_playerId_key" ON "User"("playerId");
-- CreateIndex (backs the Phase 6 friend-lookup-by-playerId query)
CREATE INDEX "User_playerId_idx" ON "User"("playerId");
