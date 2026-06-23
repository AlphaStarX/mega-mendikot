-- Mega Mindikot 5v5 — Phase 3: leaderboard index.
-- Indexes User.wins so the leaderboard's `ORDER BY wins DESC LIMIT 50` is
-- index-backed as the player base grows. Additive; non-locking at this scale.

CREATE INDEX "User_wins_idx" ON "User"("wins");
