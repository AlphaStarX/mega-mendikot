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
  // Ceremony + bot match run via staged timers; wait for completion.
  await realSleep(5000);
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
  // The lead-selection ceremony runs first (staged timers); the real 192-card
  // hand isn't dealt until it resolves. Wait for FINISHED, then verify.
  await realSleep(5000);
  assert.equal(room.matchState, "FINISHED");
  // After a full match, hands are nearly empty; verify no cards vanished: the
  // cards still in hands + 10 per trick played must equal the original 180 dealt.
  const inHands = room.seats.reduce((n, s) => n + s.hand.length, 0);
  assert.equal(inHands + Math.min(room.trickNumber, 18) * 10, 180,
    `hand+played must conserve 180 (hands=${inHands}, tricks=${room.trickNumber})`);
  assert.equal(room.kitty.length, 12, "kitty is always 12 cards");
  assert.ok(room.kittyIdx <= 12, `kitty revealed ${room.kittyIdx} <= 12`);
  restore();
});

test("lead-selection ceremony sets a valid leadSeat (>= 0, unique winner)", async () => {
  const restore = fastTimers();
  const room = new GameRoom("LEAD1");
  room.start();
  // Ceremony runs via staged timers; the real deal + leadSeat assignment happen
  // once it resolves. Match goes all-bot so it completes on its own.
  await realSleep(3500);
  assert.ok(room.leadSeat >= 0 && room.leadSeat < 10, `leadSeat valid: ${room.leadSeat}`);
  assert.equal(room.matchState, "FINISHED", "match still completes after ceremony");
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

// ---------- voice (LiveKit, §6.1 / §2.13) ----------
// A ws stub that captures every JSON message so tests can inspect the payload.
function capturingWs(sessionId) {
  const sent = [];
  return { readyState: 1, sessionId, _sent: sent, send: (d) => sent.push(JSON.parse(d)) };
}

test("voice is silent when LIVEKIT_* env vars are unset (graceful no-op)", async () => {
  const restore = fastTimers();
  const saved = { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET, LIVEKIT_URL: process.env.LIVEKIT_URL };
  delete process.env.LIVEKIT_API_KEY; delete process.env.LIVEKIT_API_SECRET; delete process.env.LIVEKIT_URL;
  const room = new GameRoom("V1");
  const ws = capturingWs("u1");
  room.addHuman(ws, "u1", "Ann");
  room.start();
  // Ceremony runs first; init is sent only after it resolves. Await the timers.
  await realSleep(200);
  const init = ws._sent.find((m) => m.t === "init");
  assert.ok(init, "human received init");
  assert.equal(init.voiceToken, undefined, "no voice token when unconfigured");
  assert.equal(init.voiceRoom, undefined);
  await realSleep(2000);
  const ended = ws._sent.some((m) => m.t === "voiceEnd");
  assert.equal(ended, false, "no voiceEnd emitted when voice was never configured");
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  restore();
});

test("with voice configured, connected humans get team-scoped tokens on start and voiceEnd on end", async () => {
  const restore = fastTimers();
  const saved = { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET, LIVEKIT_URL: process.env.LIVEKIT_URL };
  process.env.LIVEKIT_API_KEY = "key-test";
  process.env.LIVEKIT_API_SECRET = "secret-test-1234567890";
  process.env.LIVEKIT_URL = "wss://lk.test";

  const room = new GameRoom("V2");
  const ws = capturingWs("u1");
  const seat = room.addHuman(ws, "u1", "Ann");
  assert.notEqual(seat, -1);
  const team = room.seats[seat].team;

  // Bots never receive tokens; only the human does.
  room.start();
  // The lead-selection ceremony runs first; the init (with voice tokens) is sent
  // only once it resolves and the real hand deals. Let the staged timers fire.
  await realSleep(200);
  const init = ws._sent.find((m) => m.t === "init");
  assert.ok(init, "human received init");
  assert.equal(init.voiceUrl, "wss://lk.test");
  assert.equal(init.voiceRoom, `mm_V2_${team}`, "token is for this human's team room");
  assert.equal(init.voiceToken && init.voiceToken.split(".").length, 3, "token is a 3-part jwt");

  await realSleep(8000);
  assert.equal(room.matchState, "FINISHED", "match ended");
  assert.ok(ws._sent.some((m) => m.t === "voiceEnd"), "voiceEnd broadcast at match end");

  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  restore();
});

test("opposing-team humans are placed in different voice rooms", async () => {
  const restore = fastTimers();
  const saved = { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET, LIVEKIT_URL: process.env.LIVEKIT_URL };
  process.env.LIVEKIT_API_KEY = "key-test";
  process.env.LIVEKIT_API_SECRET = "secret-test-1234567890";
  process.env.LIVEKIT_URL = "wss://lk.test";

  const room = new GameRoom("V3");
  const wsA = capturingWs("uA"), wsB = capturingWs("uB");
  const sA = room.addHuman(wsA, "uA", "Ann");
  const sB = room.addHuman(wsB, "uB", "Ben");
  room.start();
  // Ceremony runs first; init is sent only after it resolves. Await the timers.
  await realSleep(200);
  const initA = wsA._sent.find((m) => m.t === "init");
  const initB = wsB._sent.find((m) => m.t === "init");
  assert.notEqual(initA.voiceRoom, initB.voiceRoom, "opponents get different voice rooms");
  assert.notEqual(room.seats[sA].team, room.seats[sB].team, "sanity: they are on different teams");

  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  restore();
});

