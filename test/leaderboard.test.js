// Phase 3 — leaderboard ranking logic. computeLeaderboardRows is a pure function
// of raw User rows (no DB), so it's fast and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLeaderboardRows } from "../server/leaderboard.js";

// Helper: build a raw user row in the shape the Prisma query returns.
function u(id, name, wins, losses, draws, matchesPlayed) {
  return { id, displayName: name, wins, losses, draws, matchesPlayed, tensCaptured: 0 };
}

test("computeLeaderboardRows: sorts by wins descending", () => {
  const users = [u("1", "Ann", 3, 5, 0, 8), u("2", "Bob", 10, 2, 0, 12), u("3", "Cara", 7, 1, 0, 8)];
  const rows = computeLeaderboardRows(users);
  assert.deepEqual(rows.map((r) => r.name), ["Bob", "Cara", "Ann"]);
});

test("computeLeaderboardRows: assigns sequential 1-based ranks", () => {
  const users = [u("1", "Ann", 3, 5, 0, 8), u("2", "Bob", 10, 2, 0, 12), u("3", "Cara", 7, 1, 0, 8)];
  const rows = computeLeaderboardRows(users);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test("computeLeaderboardRows: ties broken by fewer matches played (skill tiebreak)", () => {
  // Both have 5 wins, but Cara reached it in fewer total games -> ranks higher.
  const users = [u("1", "Ann", 5, 5, 0, 10), u("2", "Bob", 5, 1, 0, 6)];
  const rows = computeLeaderboardRows(users);
  assert.equal(rows[0].name, "Bob", "fewer matches wins the tie");
  assert.equal(rows[1].name, "Ann");
});

test("computeLeaderboardRows: computes winRate over decisive games (draws excluded)", () => {
  // 4W / 2L + 2D -> decisive = 6, winRate = 4/6 = 67%
  const rows = computeLeaderboardRows([u("1", "Ann", 4, 2, 2, 8)]);
  assert.equal(rows[0].winRate, 67);
});

test("computeLeaderboardRows: winRate null when no decisive games (only draws)", () => {
  // 0W / 0L / 3D -> decisive = 0 -> null (can't divide)
  const rows = computeLeaderboardRows([u("1", "Ann", 0, 0, 3, 3)]);
  assert.equal(rows[0].winRate, null);
});

test("computeLeaderboardRows: min-matches floor drops 0-match signups", () => {
  const users = [
    u("1", "Ann", 0, 0, 0, 0),   // fresh signup — filtered
    u("2", "Bob", 1, 0, 0, 1),   // played once — kept
  ];
  const rows = computeLeaderboardRows(users);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Bob");
});

test("computeLeaderboardRows: respects the max cap", () => {
  const users = [];
  for (let i = 0; i < 100; i++) users.push(u(String(i), `P${i}`, 100 - i, 0, 0, 1));
  const rows = computeLeaderboardRows(users, { max: 10 });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[9].rank, 10);
});

test("computeLeaderboardRows: empty input -> empty result", () => {
  assert.deepEqual(computeLeaderboardRows([]), []);
});

test("computeLeaderboardRows: non-array input -> empty result (defensive)", () => {
  assert.deepEqual(computeLeaderboardRows(null), []);
  assert.deepEqual(computeLeaderboardRows(undefined), []);
});

test("computeLeaderboardRows: carries matchesPlayed and tensCaptured through", () => {
  const rows = computeLeaderboardRows([{ id: "1", displayName: "Ann", wins: 2, losses: 1, draws: 1, matchesPlayed: 4, tensCaptured: 9 }]);
  assert.equal(rows[0].matchesPlayed, 4);
  assert.equal(rows[0].tensCaptured, 9);
});
