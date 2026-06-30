// Mega Mindikot 5v5 — Phase 3: leaderboard ranking.
//
// Pure function of raw User rows (no DB access) so it's unit-testable without a
// database. The handler in index.js does the Prisma findMany, then hands the raw
// rows here to sort, rank, and augment with a win rate.

import { levelFromXp } from "../shared/identity.js";

// Minimum matches a player must have to appear on the board. Filters out fresh
// 0-0-0 signups that would clutter the bottom. (DB-side the query also filters
// matchesPlayed > 0; this is the client-of-raw-rows equivalent.)
export const LEADERBOARD_MIN_MATCHES = 1;
export const LEADERBOARD_MAX_ROWS = 50;

// Take raw user rows ({ id, displayName, wins, losses, draws, matchesPlayed,
// tensCaptured, xp }) and return ranked leaderboard rows. Sorts by wins desc,
// then matchesPlayed asc (a player who reached N wins in fewer games ranks higher
// — a light skill tiebreak), assigns a 1-based rank, and computes winRate (wins
// over decisive games: wins+losses; draws excluded, matching the profile screen).
// Phase 5: also carries xp + derived level for the per-row level badge. Drops any
// row under the min-matches floor. Never throws — defensive on inputs.
export function computeLeaderboardRows(users, { max = LEADERBOARD_MAX_ROWS } = {}) {
  if (!Array.isArray(users)) return [];
  return users
    .filter((u) => u && (u.matchesPlayed || 0) >= LEADERBOARD_MIN_MATCHES)
    .map((u) => {
      const xp = u.xp || 0;
      return {
        id: u.id,
        name: u.displayName || "Player",
        wins: u.wins || 0,
        losses: u.losses || 0,
        draws: u.draws || 0,
        matchesPlayed: u.matchesPlayed || 0,
        tensCaptured: u.tensCaptured || 0,
        xp,                                  // Phase 5 — for the level badge
        level: levelFromXp(xp),              // Phase 5 — derived from xp
        country: u.country || null,          // Phase 4 — rendered as a flag emoji
        avatar: u.avatar || null,            // Phase 4 — emoji avatar
      };
    })
    .sort((a, b) => b.wins - a.wins || a.matchesPlayed - b.matchesPlayed || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((u, i) => {
      const decisive = u.wins + u.losses;
      return {
        ...u,
        rank: i + 1,
        winRate: decisive > 0 ? Math.round((u.wins / decisive) * 100) : null,
      };
    });
}
