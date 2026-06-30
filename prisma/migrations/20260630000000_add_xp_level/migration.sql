-- Mega Mindikot 5v5 — Phase 5: XP + player levels.
-- Adds two columns to User, both defaulting so existing rows + new signups start
-- clean (0 XP, level 1). xp is incremented at match end via GameRoom.recordStats()
-- (using xpForOutcome); level is derived from xp at read time (levelFromXp) so it
-- never drifts, and is also stored here for future indexing/ranking.

-- AddColumns
ALTER TABLE "User" ADD COLUMN "xp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;
