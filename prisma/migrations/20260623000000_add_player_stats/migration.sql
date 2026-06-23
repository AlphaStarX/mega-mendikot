-- Mega Mindikot 5v5 — Phase 2: aggregate player stats.
-- Adds 5 lifetime-stat columns to User, all defaulting to 0 so existing rows
-- and new signups start clean. Recorded incrementally at match end
-- (GameRoom.recordStats). No per-match history table yet.

-- AddColumns
ALTER TABLE "User" ADD COLUMN "wins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "losses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "draws" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "matchesPlayed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "tensCaptured" INTEGER NOT NULL DEFAULT 0;
