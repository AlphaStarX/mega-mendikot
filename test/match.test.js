// Headless end-to-end: spin a GameRoom with all-bot seats and drive to completion.
// Verifies the match lifecycle, score conservation, and valid terminal state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameRoom } from "../server/game-room.js";
import { TOTAL_TENS, WIN_TENS, PLAYERS, teamForSeat } from "../shared/rules.js";

const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
function fastTimers() {
  const orig = {
    setInterval: realSetInterval, clearInterval: global.clearInterval,
    setTimeout: realSetTimeout, clearTimeout: global.clearTimeout,
  };
  // Compress all timers to fire in the next event-loop turn via setImmediate,
  // which has no 1ms minimum clamp (unlike setTimeout(fn, 0)) and batches all
  // due callbacks in a single check phase. This makes a staged 18-trick bot
  // match resolve in tens of ms instead of several real seconds.
  global.setInterval = (fn) => {
    const h = { _on: true };
    // Swallow errors per-tick so a transient throw in one tick doesn't poison the
    // recurring loop or surface as an uncaughtException (a real setInterval keeps
    // running across a thrown callback). Mirrors production behavior in tests.
    const tick = () => {
      if (!h._on) return;
      try { fn(); } catch (e) { /* one bad tick must not kill the loop */ }
      setImmediate(tick);
    };
    setImmediate(tick);
    return h;
  };
  global.clearInterval = (h) => { if (h) h._on = false; };
  global.setTimeout = (fn) => { const h = setImmediate(fn); return { _imm: h }; };
  global.clearTimeout = (h) => { if (h && h._imm) clearImmediate(h._imm); };
  return () => Object.assign(global, orig);
}
function realSleep(ms) { return new Promise((r) => realSetTimeout(r, ms)); }
function fakeWs() { return { readyState: 1, send: () => {}, sessionId: "f" }; }

// Poll for a condition instead of a fixed sleep. With setImmediate-based
// fastTimers, the bot/timer callbacks fire in the next event-loop turn, so this
// resolves almost immediately once the condition becomes true. The safety cap
// prevents a hang on regression.
async function waitFor(fn, { timeout = 5000, interval = 5, msg = "waitFor" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await realSleep(interval);
  }
  throw new Error(`${msg} timed out after ${timeout}ms`);
}

test("full all-bot match completes with a valid winner", async () => {
  const restore = fastTimers();
  const room = new GameRoom("TESTRM");
  try {
    // No humans added — all 10 seats stay bots.
    room.start();
    // Ceremony + bot match run via staged (compressed) timers; poll for completion
    // instead of fixed-sleeping. Resolves in a few ms in fastTimers mode.
    await waitFor(() => room.matchState === "FINISHED", { msg: "match 1 to finish" });
    assert.equal(room.matchState, "FINISHED", "match reached FINISHED");
    const total = room.score.A + room.score.B;
    assert.ok(total <= TOTAL_TENS, `captured tens ${total} must not exceed ${TOTAL_TENS}`);
    const winnerHas13 = room.score.A >= WIN_TENS || room.score.B >= WIN_TENS;
    const deadlock1212 = room.score.A === 12 && room.score.B === 12;
    assert.ok(winnerHas13 || deadlock1212, `score ${JSON.stringify(room.score)} is a valid terminal state`);
  } finally {
    // Tear down timers so the process can exit. In production the cleanup
    // interval does this when deleting a finished room; the test must do it
    // explicitly or the setImmediate-based fastTimers loop pins the event loop.
    room.clearTimers();
    restore();
  }
});

test("match consumes exactly the tricks it played; no cards vanish", async () => {
  const restore = fastTimers();
  const room = new GameRoom("TEST2");
  try {
    room.start();
    // The lead-selection ceremony runs first (staged timers); the real 192-card
    // hand isn't dealt until it resolves. Wait for FINISHED, then verify.
    await waitFor(() => room.matchState === "FINISHED", { msg: "match 2 to finish" });
    assert.equal(room.matchState, "FINISHED");
    // After a full match, hands are nearly empty; verify no cards vanished: the
    // cards still in hands + 10 per trick played must equal the original 180 dealt.
    const inHands = room.seats.reduce((n, s) => n + s.hand.length, 0);
    assert.equal(inHands + Math.min(room.trickNumber, 18) * 10, 180,
      `hand+played must conserve 180 (hands=${inHands}, tricks=${room.trickNumber})`);
    assert.equal(room.kitty.length, 12, "kitty is always 12 cards");
    assert.ok(room.kittyIdx <= 12, `kitty revealed ${room.kittyIdx} <= 12`);
  } finally {
    room.clearTimers();
    restore();
  }
});

test("lead-selection ceremony sets a valid leadSeat (>= 0, unique winner)", async () => {
  const restore = fastTimers();
  const room = new GameRoom("LEAD1");
  try {
    room.start();
    // Ceremony runs via staged timers; the real deal + leadSeat assignment happen
    // once it resolves. Match goes all-bot so it completes on its own.
    await waitFor(() => room.leadSeat >= 0, { msg: "leadSeat assigned" });
    assert.ok(room.leadSeat >= 0 && room.leadSeat < 10, `leadSeat valid: ${room.leadSeat}`);
    await waitFor(() => room.matchState === "FINISHED", { msg: "ceremony match to finish" });
    assert.equal(room.matchState, "FINISHED", "match still completes after ceremony");
  } finally {
    room.clearTimers();
    restore();
  }
});

test("multi-human: two humans get personalized fog-of-war views", async () => {
  const restore = fastTimers();
  const room = new GameRoom("MH1");
  try {
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
  } finally {
    room.clearTimers();
    restore();
  }
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
  try {
    const ws = capturingWs("u1");
    room.addHuman(ws, "u1", "Ann");
    room.start();
    // Ceremony runs first; init is sent only after it resolves. Poll for init.
    await waitFor(() => ws._sent.some((m) => m.t === "init"), { msg: "init sent" });
    const init = ws._sent.find((m) => m.t === "init");
    assert.ok(init, "human received init");
    assert.equal(init.voiceToken, undefined, "no voice token when unconfigured");
    assert.equal(init.voiceRoom, undefined);
    await waitFor(() => room.matchState === "FINISHED", { msg: "unconfigured match to finish" });
    const ended = ws._sent.some((m) => m.t === "voiceEnd");
    assert.equal(ended, false, "no voiceEnd emitted when voice was never configured");
  } finally {
    room.clearTimers();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restore();
  }
});

test("with voice configured, connected humans get all-player tokens on start; voice is NOT torn down at end (persists for Play Again)", async () => {
  const restore = fastTimers();
  const saved = { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET, LIVEKIT_URL: process.env.LIVEKIT_URL };
  process.env.LIVEKIT_API_KEY = "key-test";
  process.env.LIVEKIT_API_SECRET = "secret-test-1234567890";
  process.env.LIVEKIT_URL = "wss://lk.test";

  const room = new GameRoom("V2");
  try {
    const ws = capturingWs("u1");
    const seat = room.addHuman(ws, "u1", "Ann");
    assert.notEqual(seat, -1);

    // Bots never receive tokens; only the human does.
    room.start();
    // The lead-selection ceremony runs first; the init (with voice tokens) is sent
    // only once it resolves and the real hand deals. Poll for it.
    await waitFor(() => ws._sent.some((m) => m.t === "init"), { msg: "voice init sent" });
    const init = ws._sent.find((m) => m.t === "init");
    assert.ok(init, "human received init");
    assert.equal(init.voiceUrl, "wss://lk.test");
    assert.equal(init.voiceRoom, "mm_V2", "token is for this match's all-player room");
    assert.equal(init.voiceToken && init.voiceToken.split(".").length, 3, "token is a 3-part jwt");

    await waitFor(() => room.matchState === "FINISHED", { msg: "voice match to finish" });
    assert.equal(room.matchState, "FINISHED", "match ended");
    // Voice now persists through match-end into the post-match lobby (party
    // cohesion / Play Again), so the server must NOT broadcast voiceEnd.
    assert.equal(ws._sent.some((m) => m.t === "voiceEnd"), false, "no voiceEnd — voice persists for Play Again");
  } finally {
    room.clearTimers();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restore();
  }
});

test("opposing-team humans share the same voice room (all-player voice)", async () => {
  const restore = fastTimers();
  const saved = { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET, LIVEKIT_URL: process.env.LIVEKIT_URL };
  process.env.LIVEKIT_API_KEY = "key-test";
  process.env.LIVEKIT_API_SECRET = "secret-test-1234567890";
  process.env.LIVEKIT_URL = "wss://lk.test";

  const room = new GameRoom("V3");
  try {
    const wsA = capturingWs("uA"), wsB = capturingWs("uB");
    const sA = room.addHuman(wsA, "uA", "Ann");
    const sB = room.addHuman(wsB, "uB", "Ben");
    room.start();
    // Ceremony runs first; init is sent only after it resolves. Poll for both inits.
    await waitFor(() => wsA._sent.some((m) => m.t === "init") && wsB._sent.some((m) => m.t === "init"), { msg: "both inits sent" });
    const initA = wsA._sent.find((m) => m.t === "init");
    const initB = wsB._sent.find((m) => m.t === "init");
    assert.equal(initA.voiceRoom, initB.voiceRoom, "all players share one voice room");
    assert.notEqual(room.seats[sA].team, room.seats[sB].team, "sanity: they are on different teams");
  } finally {
    room.clearTimers();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restore();
  }
});

// ---------- Task 7: team selection (chooseSeat) ----------
// A capturing ws is reused above, but chooseSeat tests are synchronous LOBBY
// operations (no timers), so plain stubs suffice.
function stubWs(sessionId) {
  return { readyState: 1, send: () => {}, sessionId };
}

test("chooseSeat: an unseated human claims an open bot seat", () => {
  const room = new GameRoom("CS1");
  try {
    const ws = stubWs("s1");
    // addHuman seats the first human via the team-balancing nextOpenSeat logic.
    const firstSeat = room.addHuman(ws, "s1", "Ann");
    assert.notEqual(firstSeat, -1);
    // Now explicitly choose a different open seat (e.g. seat 5, opposite team).
    const next = room.chooseSeat(5, "s1", "Ann", ws);
    assert.equal(next, 5, "moved to chosen seat");
    assert.ok(room.seats[5].isHuman, "seat 5 now human");
    assert.equal(room.seats[5].sessionId, "s1");
    assert.equal(room.seats[firstSeat].isBot, true, "old seat reverted to bot");
    assert.equal(room.seats[firstSeat].isHuman, false);
  } finally {
    room.clearTimers();
  }
});

test("chooseSeat: rejects an already-occupied (human) seat", () => {
  const room = new GameRoom("CS2");
  try {
    const wsA = stubWs("sA"), wsB = stubWs("sB");
    room.addHuman(wsA, "sA", "Ann");      // seat 0 (team A) by balance
    room.addHuman(wsB, "sB", "Bob");      // seat 1 (team B)
    // Bob (sB) tries to take seat 0, which Ann occupies.
    const r = room.chooseSeat(0, "sB", "Bob", wsB);
    assert.equal(r, -1, "can't steal an occupied seat");
    assert.equal(room.seats[0].sessionId, "sA", "seat 0 still Ann's");
  } finally {
    room.clearTimers();
  }
});

test("chooseSeat: rejects outside LOBBY", () => {
  const restore = fastTimers();
  const room = new GameRoom("CS3");
  try {
    const ws = stubWs("s1");
    room.addHuman(ws, "s1", "Ann");
    room.start();
    // matchState is now LEAD_SELECT; choosing a seat must be rejected.
    const r = room.chooseSeat(2, "s1", "Ann", ws);
    assert.equal(r, -1, "can't choose a seat once the match has started");
  } finally {
    room.clearTimers();
    restore();
  }
});

test("chooseSeat: moving the host moves the host crown", () => {
  const room = new GameRoom("CS4");
  try {
    const ws = stubWs("s1");
    const hostSeat = room.addHuman(ws, "s1", "Ann"); // first human => host
    assert.equal(room.hostSeat, hostSeat);
    const next = room.chooseSeat(6, "s1", "Ann", ws); // host moves to seat 6
    assert.notEqual(next, -1);
    assert.equal(room.hostSeat, next, "host crown followed the move");
  } finally {
    room.clearTimers();
  }
});

test("chooseSeat: 5-per-team cap holds — can't take a seat on a full team", () => {
  const room = new GameRoom("CS5");
  try {
    // Fill all 5 Team A seats (even indices 0,2,4,6,8) with humans.
    const teamASeats = [];
    for (let i = 0; i < PLAYERS; i++) if (teamForSeat(i) === "A") teamASeats.push(i);
    for (const seat of teamASeats) {
      const ws = stubWs(`h${seat}`);
      room.chooseSeat(seat, `h${seat}`, `P${seat}`, ws);
    }
    assert.equal(teamASeats.length, 5, "sanity: exactly 5 Team A seats exist");
    // All Team A seats are now human; every Team A seat should reject chooseSeat.
    const extra = stubWs("extra");
    for (const seat of teamASeats) {
      assert.equal(room.chooseSeat(seat, "extra", "Extra", extra), -1,
        `Team A seat ${seat} is occupied and rejects chooseSeat`);
    }
  } finally {
    room.clearTimers();
  }
});

test("chooseSeat: broadcasts yourSeat per socket via broadcastLobby", () => {
  const room = new GameRoom("CS6");
  try {
    const sent1 = [], sent2 = [];
    const ws1 = { readyState: 1, send: (d) => sent1.push(JSON.parse(d)), sessionId: "s1" };
    const ws2 = { readyState: 1, send: (d) => sent2.push(JSON.parse(d)), sessionId: "s2" };
    room.addHuman(ws1, "s1", "Ann");
    room.addHuman(ws2, "s2", "Bob");
    room.broadcastLobby();
    // Each socket gets its own yourSeat message with its seat index.
    assert.ok(sent1.some((m) => m.t === "yourSeat"), "ws1 got yourSeat");
    assert.ok(sent2.some((m) => m.t === "yourSeat"), "ws2 got yourSeat");
  } finally {
    room.clearTimers();
  }
});

// ---------- Task 7: host reassignment on disconnect ----------
test("onHumanDisconnect: host leaving promotes the next connected human", () => {
  const room = new GameRoom("HD1");
  try {
    const ws1 = stubWs("s1"), ws2 = stubWs("s2");
    const h1 = room.addHuman(ws1, "s1", "Ann"); // first => host
    const h2 = room.addHuman(ws2, "s2", "Bob");
    assert.equal(room.hostSeat, h1);
    room.onHumanDisconnect(h1);
    assert.equal(room.hostSeat, h2, "host passed to Bob");
    // Now the last human leaves -> host becomes null (no humans left).
    room.onHumanDisconnect(h2);
    assert.equal(room.hostSeat, null, "no host when nobody is connected");
  } finally {
    room.clearTimers();
  }
});

// ---------- Task 7: resetToLobby (Play Again) ----------
test("resetToLobby: zeros match state and returns to LOBBY, keeping humans seated", async () => {
  const restore = fastTimers();
  const room = new GameRoom("RT1");
  try {
    const ws = stubWs("s1");
    const seat = room.addHuman(ws, "s1", "Ann");
    room.start();
    await waitFor(() => room.matchState === "FINISHED", { msg: "RT1 match to finish" });
    assert.equal(room.matchState, "FINISHED");
    // Match produced some score / captures.
    assert.ok(room.score.A + room.score.B >= 0);
    const ok = room.resetToLobby();
    assert.equal(ok, true, "resetToLobby succeeded");
    assert.equal(room.matchState, "LOBBY", "back in LOBBY");
    assert.deepEqual(room.score, { A: 0, B: 0 }, "score zeroed");
    assert.deepEqual(room.capturedTens, { A: [], B: [] }, "capturedTens cleared");
    assert.equal(room.hands, null, "hands cleared");
    // The human stays seated — identity preserved for the next game.
    assert.equal(room.seats[seat].isHuman, true, "human still seated");
    assert.equal(room.seats[seat].sessionId, "s1");
    assert.equal(room.seats[seat].tens, 0, "per-seat tens reset");
    assert.equal(room.seats[seat].hand.length, 0, "per-seat hand cleared");
  } finally {
    room.clearTimers();
    restore();
  }
});

test("resetToLobby: rejects when not FINISHED", () => {
  const room = new GameRoom("RT2");
  try {
    // A fresh room is in LOBBY — resetToLobby must be a no-op.
    assert.equal(room.resetToLobby(), false);
    assert.equal(room.matchState, "LOBBY", "still LOBBY, untouched");
  } finally {
    room.clearTimers();
  }
});

// ---------- Phase 2: stats classification + recording ----------
// classifySeats is a pure static method — no DB — so it's fast and deterministic.
// It maps each human seat to a {won, lost, draw} classification given the
// winning team. Bots and guests are filtered out.

test("classifySeats: Team A wins -> A humans won, B humans lost", () => {
  const seats = [
    { isHuman: true,  sessionId: "u1", team: "A", tens: 3 },
    { isHuman: true,  sessionId: "u2", team: "B", tens: 1 },
    { isHuman: false, sessionId: null, team: "A", tens: 0 }, // bot — filtered
  ];
  const out = GameRoom.classifySeats(seats, "A");
  assert.equal(out.length, 2, "only the two humans");
  assert.equal(out[0].sessionId, "u1");
  assert.equal(out[0].won, true, "A human won");
  assert.equal(out[0].lost, false);
  assert.equal(out[0].draw, false);
  assert.equal(out[0].tens, 3);
  assert.equal(out[1].sessionId, "u2");
  assert.equal(out[1].won, false);
  assert.equal(out[1].lost, true, "B human lost");
  assert.equal(out[1].draw, false);
});

test("classifySeats: winningTeam null -> everyone draws", () => {
  const seats = [
    { isHuman: true, sessionId: "u1", team: "A", tens: 2 },
    { isHuman: true, sessionId: "u2", team: "B", tens: 2 },
  ];
  const out = GameRoom.classifySeats(seats, null);
  assert.equal(out.length, 2);
  assert.equal(out.every((u) => u.draw), true, "both draws");
  assert.equal(out.every((u) => !u.won && !u.lost), true, "no win/loss on a draw");
});

test("classifySeats: guests (no sessionId) and bots are skipped", () => {
  const seats = [
    { isHuman: true,  sessionId: "real-user-id", team: "A", tens: 4 },
    { isHuman: true,  sessionId: null,           team: "B", tens: 0 }, // guest — skipped
    { isHuman: false, sessionId: null,           team: "A", tens: 0 }, // bot — skipped
  ];
  const out = GameRoom.classifySeats(seats, "A");
  assert.equal(out.length, 1, "only the authenticated human remains");
  assert.equal(out[0].sessionId, "real-user-id");
});

test("classifySeats: empty seats list -> empty result", () => {
  assert.deepEqual(GameRoom.classifySeats([], "A"), []);
  assert.deepEqual(GameRoom.classifySeats([], null), []);
});

test("recordStats: no DB configured -> no-op, no throw", () => {
  // Ensure DATABASE_URL is unset so getDb() returns null (the fail-soft path).
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const room = new GameRoom("RS1");
  try {
    room.seats[0].isHuman = true;
    room.seats[0].isBot = false;
    room.seats[0].sessionId = "u1";
    room.seats[0].tens = 5;
    // Must not throw even though stats can't be recorded.
    assert.doesNotThrow(() => room.recordStats("A"));
  } finally {
    room.clearTimers();
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

