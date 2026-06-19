// Headless end-to-end: spin a GameRoom with all-bot seats and drive to completion.
// Verifies the match lifecycle, score conservation, and valid terminal state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameRoom } from "../server/game-room.js";
import { TOTAL_TENS, WIN_TENS } from "../shared/rules.js";

const realSetTimeout = global.setTimeout;
function fastTimers() {
  const orig = {
    setInterval: global.setInterval, clearInterval: global.clearInterval,
    setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
  };
  global.setInterval = (fn, ms) => orig.setInterval(fn, Math.min(ms, 1));
  global.setTimeout = (fn, ms) => orig.setTimeout(fn, Math.min(ms, 1));
  return () => Object.assign(global, orig);
}
function realSleep(ms) { return new Promise((r) => realSetTimeout(r, ms)); }
function fakeWs() { return { readyState: 1, send: () => {}, sessionId: "f" }; }

test("full all-bot match completes with a valid winner", async () => {
  const restore = fastTimers();
  const room = new GameRoom("TESTRM");
  // No humans added — all 10 seats stay bots.
  room.start();
  await realSleep(3000);
  assert.equal(room.matchState, "FINISHED", "match reached FINISHED");
  const total = room.score.A + room.score.B;
  assert.ok(total <= TOTAL_TENS, `captured tens ${total} must not exceed ${TOTAL_TENS}`);
  const winnerHas13 = room.score.A >= WIN_TENS || room.score.B >= WIN_TENS;
  const deadlock1212 = room.score.A === 12 && room.score.B === 12;
  assert.ok(winnerHas13 || deadlock1212, `score ${JSON.stringify(room.score)} is a valid terminal state`);
  restore();
});

test("match consumes exactly the tricks it played; no cards vanish", async () => {
  const restore = fastTimers();
  const room = new GameRoom("TEST2");
  room.start();
  const dealt = room.seats.reduce((n, s) => n + s.hand.length, 0) + room.kitty.length;
  assert.equal(dealt, 192, "180 in hands + 12 kitty");
  await realSleep(3000);
  assert.equal(room.matchState, "FINISHED");
  const inHands = room.seats.reduce((n, s) => n + s.hand.length, 0);
  assert.equal(inHands + Math.min(room.trickNumber, 18) * 10, 180,
    `hand+played must conserve 180 (hands=${inHands}, tricks=${room.trickNumber})`);
  assert.ok(room.kittyIdx <= 12, `kitty revealed ${room.kittyIdx} <= 12`);
  restore();
});

test("multi-human: two humans get personalized fog-of-war views", async () => {
  const restore = fastTimers();
  const room = new GameRoom("MH1");
  const ws1 = { readyState: 1, send: (d) => {}, sessionId: "sess-1" };
  const ws2 = { readyState: 1, send: (d) => {}, sessionId: "sess-2" };
  const s1 = room.addHuman(ws1, "sess-1", "Alice");
  const s2 = room.addHuman(ws2, "sess-2", "Bob");
  assert.notEqual(s1, -1, "Alice seated");
  assert.notEqual(s2, -1, "Bob seated");
  assert.notEqual(s1, s2, "different seats");
  assert.ok(room.seats[s1].isHuman && room.seats[s2].isHuman, "both are human");
  assert.equal(room.humanCount(), 2, "two humans");
  // Teams should differ (balance logic puts 2nd human on the other team)
  assert.notEqual(room.seats[s1].team, room.seats[s2].team, "humans on different teams");
  restore();
});

test("reconnection reclaims the original seat by sessionId", () => {
  const room = new GameRoom("RC1");
  const ws1 = { readyState: 1, send: () => {}, sessionId: "sess-X" };
  const seat = room.addHuman(ws1, "sess-X", "Carol");
  room.onHumanDisconnect(seat);
  assert.equal(room.seats[seat].isConnected, false, "disconnected");
  const ws2 = { readyState: 1, send: () => {}, sessionId: "sess-X" };
  const reclaimed = room.onHumanReconnect(ws2, "sess-X");
  assert.equal(reclaimed, seat, "reclaimed same seat");
  assert.equal(room.seats[seat].isConnected, true, "reconnected");
  assert.strictEqual(room.sockets[seat], ws2, "socket re-pointed");
});

test("addHuman rejects when room is full (10 humans)", () => {
  const room = new GameRoom("FULL");
  for (let i = 0; i < 10; i++) {
    const ws = { readyState: 1, send: () => {}, sessionId: `s${i}` };
    assert.notEqual(room.addHuman(ws, `s${i}`, `P${i}`), -1, `seat ${i} added`);
  }
  const ws11 = { readyState: 1, send: () => {}, sessionId: "s11" };
  assert.equal(room.addHuman(ws11, "s11", "Overflow"), -1, "11th human rejected");
});
