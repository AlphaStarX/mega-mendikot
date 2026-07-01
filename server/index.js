// Mega Mindikot 5v5 — self-contained server.
// One Node process: serves the static web client over HTTP and runs the
// authoritative WebSocket game rooms. Zero external runtime deps (Node 18+):
// WebSocket framing is implemented on top of node:http + node:crypto.
//
// Multi-room architecture: a Map<roomId, GameRoom> registry supports many
// concurrent matches. Quick-match auto-fills empty seats with bots after a
// short wait; private rooms wait for the host to start.

import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { GameRoom, TURN_SECONDS } from "./game-room.js";
import {
  authConfigured, validateSignup, cleanName, normalizeEmail,
  hashPassword, verifyPassword, signToken, verifyToken,
} from "./auth.js";
import { getDb, closeDb } from "./db.js";
import { debugAllowed } from "./debug-gate.js";
import { computeLeaderboardRows, LEADERBOARD_MAX_ROWS } from "./leaderboard.js";
import { generatePlayerId, isValidCountry, isValidAvatar, levelFromXp, normalizePlayerId } from "../shared/identity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, "..", "client");
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const FILL_TIMER_MS = parseInt(process.env.FILL_TIMER_MS || "20000", 10); // quick-match bot fill delay
const ROOM_IDLE_MS = 30000; // finished room with no humans is cleaned up after this

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// Debug-panel gate lives in ./debug-gate.js (imported above) so it can be
// unit-tested. See test/debug-gate.test.js for the full truth table.

const server = http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/" || url === "/index") url = "/index.html";
    if (url.includes("..")) { res.writeHead(403); return res.end("Forbidden"); }
    const filePath = join(CLIENT_DIR, url);
    let data = await readFile(filePath);
    // Inject the debug scripts into index.html ONLY when the gate passes.
    // Normal players (no ?debug=1, or wrong key) get the plain page — no debug code.
    // NOTE: client files are served FLAT (CLIENT_DIR = client/, so the URL is
    // /debug.js, NOT /client/debug.js). debug-helpers.js loads before debug.js.
    // CRITICAL ORDER: these must load BEFORE client.js. client.js checks
    // `window.__dbg` at the bottom of the file and calls hook() — if debug.js
    // hasn't run yet, window.__dbg is undefined and the panel never arms. So we
    // inject ahead of <script src="/client.js"> rather than before </body>.
    if (url === "/index.html" && debugAllowed(req)) {
      const injection = '  <script src="/debug-helpers.js"></script>\n  <script src="/debug.js"></script>\n';
      data = Buffer.from(data.toString().replace('<script src="/client.js">', injection + '<script src="/client.js">'));
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// --- Minimal WebSocket server (RFC 6455) ---
server.on("upgrade", (req, socket) => {
  if ((req.url || "").split("?")[0] !== "/ws") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  const head = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n");
  socket.write(head);
  const ws = makeWs(socket);
  wss.emit("connection", ws);
});

function makeWs(socket) {
  const ws = {
    socket, readyState: 1, OPEN: 1, CLOSED: 3, _listeners: {},
    sessionId: null, room: null, seat: null,
    userId: null, userName: null, authenticated: false,  // account auth (Phase 1)
    country: null, avatar: null,                          // Phase 4 identity (for seat display)
  };
  ws.on = (ev, fn) => { (ws._listeners[ev] ||= []).push(fn); };
  ws._emit = (ev, ...a) => (ws._listeners[ev] || []).forEach((fn) => fn(...a));
  ws.send = (data) => {
    if (ws.readyState !== 1) return;
    const frame = makeFrame(data);
    try { socket.write(frame); } catch { ws.readyState = 3; }
  };
  ws.close = () => {
    if (ws.readyState !== 1) return;
    ws.readyState = 3;
    try { socket.end(); } catch {}
  };
  let bufs = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bufs = Buffer.concat([bufs, chunk]);
    let msg;
    while ((msg = parseFrame(bufs))) {
      bufs = msg.rest;
      if (msg.opcode === 0x8) { ws.readyState = 3; ws._emit("close"); return; }
      if (msg.opcode === 0x9) { socket.write(makeFrame(msg.payload, 0xa)); continue; } // pong
      if (msg.payload != null) ws._emit("message", msg.payload.toString());
    }
  });
  socket.on("close", () => { ws.readyState = 3; ws._emit("close"); });
  socket.on("error", () => { ws.readyState = 3; ws._emit("close"); });
  return ws;
}

function makeFrame(data, opcode = 0x1) {
  const payload = Buffer.from(data, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
    payload = unmasked;
  }
  return { opcode, payload, rest: buf.slice(offset + len) };
}

const wss = { _listeners: {}, emit(ev, ...a) { (this._listeners[ev] || []).forEach((fn) => fn(...a)); }, on(ev, fn) { (this._listeners[ev] ||= []).push(fn); } };

// --- Room registry ---
const rooms = new Map(); // roomId -> GameRoom
// Every live WebSocket connection (any client with the page open — logged-in or
// guest, on the home screen or mid-match). Used for the "Online Players" count.
const sockets = new Set();
// Phase 6 — per-user socket index: userId -> Set<ws>. Lets us push real-time
// notifications (friend requests, room invites) to an online user OUTSIDE the
// sender's current room — the flat `sockets` set can't look up "is user X here".
// A user may have multiple open sockets (multiple tabs), so it's a Set. Only
// AUTHENTICATED sockets are tracked (guests have no userId to key on).
const userSockets = new Map();
// Track a socket under its userId (called on auth). Idempotent across reconnects.
function trackUserSocket(ws) {
  if (!ws || !ws.userId) return;
  let set = userSockets.get(ws.userId);
  if (!set) { set = new Set(); userSockets.set(ws.userId, set); }
  set.add(ws);
}
// Drop a socket from its user's set (called on close). Cleans up empty sets.
function untrackUserSocket(ws) {
  if (!ws || !ws.userId) return;
  const set = userSockets.get(ws.userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(ws.userId);
}
// Push a message to every open socket of an online user. Returns true if delivered
// (user online + at least one open socket), false if offline. Best-effort: a socket
// that died but hasn't fired `close` yet is skipped (readyState check).
function sendToUser(userId, msg) {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return false;
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === 1) { send(ws, msg); delivered = true; }
  }
  return delivered;
}
// Is a user currently online (any open authenticated socket)?
function isUserOnline(userId) {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return false;
  for (const ws of set) if (ws.readyState === 1) return true;
  return false;
}
function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let id;
  do {
    id = "";
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) id += chars[bytes[i] % chars.length];
  } while (rooms.has(id));
  return id;
}
function createRoom(roomId, { privateRoom = false } = {}) {
  const id = roomId || makeRoomId();
  const room = new GameRoom(id);
  room.privateRoom = privateRoom;
  rooms.set(id, room);
  return room;
}
// Find an open quick-match room (LOBBY + room for more humans), else create one.
function findOpenRoom() {
  for (const room of rooms.values()) {
    if (!room.privateRoom && room.matchState === "LOBBY" && room.humanCount() < 10) return room;
  }
  return createRoom(undefined, { privateRoom: false });
}
function getRoom(roomId) { return rooms.get(roomId) || null; }

// Auto-start a quick-match room after the fill timer if it hasn't filled.
function scheduleFillStart(room) {
  if (room._fillHandle) return;
  room._fillHandle = setTimeout(() => {
    room._fillHandle = null;
    if (room.matchState === "LOBBY" && room.humanCount() >= 1) {
      // start() sends init to each human; no lobby broadcast needed.
      room.start();
    }
  }, FILL_TIMER_MS);
}

// Periodically clean up idle rooms. A FINISHED room is reaped ONLY once no humans
// remain connected — that keeps the party together on the end screen so the host
// can hit "Play Again" (resetToLobby) instead of being dropped. Same for an empty
// LOBBY. Mirrors how private LOBBY rooms already persist for friends.
setInterval(() => {
  for (const [id, room] of rooms) {
    if ((room.matchState === "FINISHED" || room.matchState === "LOBBY") && room.humanCount() === 0) {
      room.clearTimers();
      if (room._fillHandle) { clearTimeout(room._fillHandle); room._fillHandle = null; }
      rooms.delete(id);
    }
  }
}, 10000);

// --- Connection handling ---
wss.on("connection", (ws) => {
  sockets.add(ws);
  send(ws, { t: "hello" });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    sockets.delete(ws);
    untrackUserSocket(ws);   // Phase 6 — stop pushing friend notifications to this socket
    if (ws.room && ws.seat !== null) {
      ws.room.onHumanDisconnect(ws.seat);
      if (ws.room.matchState === "LOBBY") ws.room.broadcastLobby();
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.t) {
    case "signup": handleSignup(ws, msg); break;
    case "login": handleLogin(ws, msg); break;
    case "authenticate": handleAuthenticate(ws, msg); break;
    case "logout": handleLogout(ws); break;
    case "join": handleJoin(ws, msg); break;
    case "play":
      if (ws.room && ws.seat !== null) ws.room.onPlayCardFromSeat(ws.seat, msg.cardId);
      break;
    case "ready":
      if (ws.room && ws.seat !== null) {
        ws.room.setReady(ws.seat, true);
        ws.room.broadcastLobby();
      }
      break;
    case "startGame":
      if (ws.room && ws.seat === ws.room.hostSeat) {
        // start() sends personalized init to each human (transitioning them to
        // the game screen). Do NOT broadcastLobby afterwards — that would
        // overwrite the game screen with the lobby screen.
        ws.room.start();
      }
      break;
    case "chooseSeat":
      // Player picks/moves to an open bot seat in the lobby. chooseSeat is
      // LOBBY-only; it rejects occupied seats and moves the host crown if the
      // host moves. The returned index may differ from ws.seat on a move.
      if (ws.room && ws.seat !== null && ws.room.matchState === "LOBBY" &&
          Number.isInteger(msg.seat)) {
        const name = ws.userName || ws.name || "Player";
        const next = ws.room.chooseSeat(msg.seat, ws.sessionId, name, ws);
        if (next !== -1) {
          ws.seat = next;
          ws.room.broadcastLobby();
        }
      }
      break;
    case "playAgain":
      // Host resets a FINISHED room to LOBBY, keeping everyone seated (party
      // cohesion). Quick-match rooms re-arm the 20s fill/auto-start timer; private
      // rooms wait for the host's Start button. resetToLobby re-broadcasts lobby.
      if (ws.room && ws.seat === ws.room.hostSeat && ws.room.matchState === "FINISHED") {
        ws.room.resetToLobby();
        if (!ws.room.privateRoom) scheduleFillStart(ws.room);
      }
      break;
    case "chat":
      if (ws.room && ws.seat !== null) ws.room.onChatFromSeat(ws.seat, msg.text || "");
      break;
    case "voiceToggle":
      // Mute/unmute is client-local (the publishing client mutes its own mic
      // track); the server only relays the player-facing HUD state so others
      // see who's muted. Voice is all-player, so broadcast to everyone. Allowed
      // in every non-dealing state so pre-game / in-match / end-screen / post-match
      // lobby voice all work (voice now persists through match-end). Bot toggles
      // are ignored.
      if (ws.room && ws.seat !== null && ws.room.matchState !== "DEALING" &&
          ws.room.matchState !== "LEAD_SELECT") {
        ws.room.broadcast({
          t: "voiceState",
          seat: ws.seat,
          muted: !!msg.muted,
        });
      }
      break;
    case "getStats":
      // Fetch the current user's fresh aggregate stats (e.g. to refresh the
      // Profile screen after a match). Authenticated-only; fail-soft to null.
      if (ws.authenticated && ws.userId) {
        const db = getDb();
        if (!db) { send(ws, { t: "stats", stats: null }); break; }
        db.user.findUnique({ where: { id: ws.userId }, select: STATS_FIELDS })
          .then((u) => send(ws, { t: "stats", stats: u || null }))
          .catch((e) => { console.error("getStats error:", e); send(ws, { t: "stats", stats: null }); });
      } else {
        send(ws, { t: "stats", stats: null });
      }
      break;
    case "updateProfile":
      // Profile "Edit" flow: update country and/or avatar. Authenticated-only.
      // Validates against the curated lists (rejects arbitrary input); null/empty
      // clears the field. Replies with a fresh identity payload so the client
      // state + any rendered surfaces update.
      if (ws.authenticated && ws.userId) {
        const db = getDb();
        if (!db) { send(ws, { t: "authError", message: "Accounts are not available." }); break; }
        // Build the update patch: only include provided + valid fields.
        const data = {};
        if (msg.country !== undefined) {
          // empty/null clears; otherwise must be a valid code
          if (msg.country === "" || msg.country === null) data.country = null;
          else if (isValidCountry(msg.country)) data.country = msg.country.toUpperCase();
          else { send(ws, { t: "authError", message: "Invalid country." }); break; }
        }
        if (msg.avatar !== undefined) {
          if (msg.avatar === "" || msg.avatar === null) data.avatar = null;
          else if (isValidAvatar(msg.avatar)) data.avatar = msg.avatar;
          else { send(ws, { t: "authError", message: "Invalid avatar." }); break; }
        }
        if (!Object.keys(data).length) { send(ws, { t: "authError", message: "Nothing to update." }); break; }
        db.user.update({ where: { id: ws.userId }, data, select: { id: true, displayName: true, playerId: true, country: true, avatar: true } })
          .then((u) => {
            ws.userName = u.displayName;
            ws.country = u.country || null;   // refresh cached seat identity
            ws.avatar = u.avatar || null;
            // Send a dedicated identity update (no token re-issue — the existing
            // JWT stays valid). The client applies these like an authOk subset.
            send(ws, {
              t: "profileUpdated", userId: u.id, name: u.displayName,
              playerId: u.playerId || null, country: u.country || null, avatar: u.avatar || null,
            });
          })
          .catch((e) => { console.error("updateProfile error:", e); send(ws, { t: "authError", message: "Update failed." }); });
      } else {
        send(ws, { t: "authError", message: "Log in to edit your profile." });
      }
      break;
    case "getLeaderboard":
      // Public leaderboard (top players by wins). No auth required — anyone,
      // including guests, can view. Reads only displayName + stats (never
      // emails/ids). Fail-soft to null if accounts aren't configured.
      {
        const db = getDb();
        if (!db) { send(ws, { t: "leaderboard", rows: null }); break; }
        db.user.findMany({
          where: { matchesPlayed: { gt: 0 } },
          orderBy: { wins: "desc" },
          take: LEADERBOARD_MAX_ROWS,
          select: { id: true, displayName: true, wins: true, losses: true, draws: true, matchesPlayed: true, tensCaptured: true, xp: true, country: true, avatar: true },
        })
          .then((users) => send(ws, { t: "leaderboard", rows: computeLeaderboardRows(users) }))
          .catch((e) => { console.error("getLeaderboard error:", e); send(ws, { t: "leaderboard", rows: null }); });
      }
      break;
    case "ping": send(ws, { t: "pong" }); break;
    case "getPresence":
      // Live "Online Players" + "Active Rooms" counters for the home screen.
      // Online = every connected socket (anyone with the page open — logged-in
      // OR guest, home screen OR mid-match), so the count reflects everyone
      // currently on the site. Active rooms = rooms with at least one human.
      {
        let activeRooms = 0;
        for (const room of rooms.values()) {
          if (room.humanCount() > 0) activeRooms++;
        }
        send(ws, { t: "presence", onlinePlayers: sockets.size, activeRooms });
      }
      break;

    // ---------- Phase 6: friends ----------
    // All auth-gated + fail-soft (null DB → benign reply). Friendship rows are one
    // per ordered pair: userId = requester, friendId = recipient, status pending
    // until accepted. A single accepted row means BOTH are friends (app symmetry).
    case "getFriends": return handleGetFriends(ws);
    case "addFriend": return handleAddFriend(ws, msg);
    case "acceptFriend": return handleAcceptFriend(ws, msg);
    case "declineFriend": return handleDeclineFriend(ws, msg);
    case "removeFriend": return handleRemoveFriend(ws, msg);
    case "inviteFriend": return handleInviteFriend(ws, msg);
  }
}

// --- account auth handlers (Phase 1) ---
// All auth flows run over the same WebSocket as the game. Fail-soft: if auth
// isn't configured (JWT_SECRET / DATABASE_URL unset), every handler replies
// authDisabled and the game plays anonymously exactly as before.

// The 5 aggregate stat fields on User (Phase 2). Used wherever we read a user
// for auth/identity so stats ride along without a second query.
const STATS_FIELDS = { wins: true, losses: true, draws: true, matchesPlayed: true, tensCaptured: true, xp: true, level: true };
function statsOf(user) {
  if (!user) return null;
  const xp = user.xp || 0;
  return {
    wins: user.wins || 0,
    losses: user.losses || 0,
    draws: user.draws || 0,
    matchesPlayed: user.matchesPlayed || 0,
    tensCaptured: user.tensCaptured || 0,
    xp,                                   // Phase 5 — cumulative XP
    level: levelFromXp(xp),               // Phase 5 — derived from xp so it never drifts
  };
}

function authReplyOk(ws, user) {
  const token = signToken({ userId: user.id, email: user.email });
  ws.userId = user.id;
  ws.userName = user.displayName;
  ws.authenticated = true;
  ws.country = user.country || null;   // cached for seat display (Phase 4)
  ws.avatar = user.avatar || null;
  ws.level = levelFromXp(user.xp || 0); // cached for the in-game/lobby level badge (Phase 5)
  trackUserSocket(ws);                 // Phase 6 — index for friend pushes
  send(ws, {
    t: "authOk", token, userId: user.id, name: user.displayName,
    stats: statsOf(user),
    playerId: user.playerId || null,   // Phase 4 — shareable code
    country: user.country || null,     // Phase 4 — 2-letter ISO code
    avatar: user.avatar || null,       // Phase 4 — emoji
  });
}

// Ensure a user has a playerId, generating + persisting one if missing (lazy
// backfill for accounts created before Phase 4). Retries on a uniqueness clash.
// Returns the playerId; the caller includes it in the auth reply. Fire-and-
// forget persistence — a failure here must never block login.
function ensurePlayerId(user) {
  if (user.playerId) return user.playerId;
  const db = getDb();
  if (!db) return null;
  const tryGen = (attempts) => {
    if (attempts <= 0) return null;
    const candidate = generatePlayerId();
    db.user.update({ where: { id: user.id }, data: { playerId: candidate } })
      .then(() => { user.playerId = candidate; })
      .catch((e) => {
        if (e && e.code === "P2002") tryGen(attempts - 1); // unique clash — retry
        else console.error("ensurePlayerId error:", e);
      });
    return candidate; // optimistic: return the candidate; the row persists async
  };
  const candidate = tryGen(5);
  if (candidate) user.playerId = candidate;
  return candidate;
}

function handleSignup(ws, msg) {
  if (!authConfigured()) { send(ws, { t: "authDisabled", message: "Accounts are not enabled on this server." }); return; }
  const email = normalizeEmail(msg && msg.email);
  const password = (msg && msg.password) || "";
  const name = cleanName((msg && msg.name) || "");
  const err = validateSignup({ email, password, name });
  if (err) { send(ws, { t: "authError", message: err }); return; }
  const db = getDb();
  db.user.findUnique({ where: { email } })
    .then((existing) => {
      if (existing) { send(ws, { t: "authError", message: "An account with that email already exists." }); return null; }
      return hashPassword(password).then(({ passwordHash, passwordSalt }) => {
        // Generate a unique playerId (retry on a clash with a tiny probability).
        const pickPlayerId = (attempts) => {
          if (attempts <= 0) return undefined; // fall back to lazy backfill on login
          const candidate = generatePlayerId();
          return db.user.findUnique({ where: { playerId: candidate } })
            .then((taken) => (taken ? pickPlayerId(attempts - 1) : candidate));
        };
        return pickPlayerId(5).then((playerId) =>
          db.user.create({ data: { email, passwordHash, passwordSalt, displayName: name, playerId } })
        );
      });
    })
    .then((user) => {
      if (!user) return;
      if (!user.playerId) ensurePlayerId(user); // safety net if generation above fell through
      authReplyOk(ws, user);
    })
    .catch((e) => {
      send(ws, { t: "authError", message: "Signup failed. Please try again." });
      console.error("signup error:", e);
    });
}

function handleLogin(ws, msg) {
  if (!authConfigured()) { send(ws, { t: "authDisabled", message: "Accounts are not enabled on this server." }); return; }
  const email = normalizeEmail(msg && msg.email);
  const password = (msg && msg.password) || "";
  if (!email || !password) { send(ws, { t: "authError", message: "Enter your email and password." }); return; }
  const db = getDb();
  db.user.findUnique({ where: { email } })
    .then((user) => {
      if (!user) { send(ws, { t: "authError", message: "No account found with that email." }); return null; }
      return verifyPassword(password, user.passwordHash, user.passwordSalt).then((ok) => (ok ? user : null));
    })
    .then((user) => {
      if (!user) { send(ws, { t: "authError", message: "Incorrect password." }); return; }
      if (!user.playerId) ensurePlayerId(user); // lazy backfill for pre-Phase-4 accounts
      authReplyOk(ws, user);
    })
    .catch((e) => {
      send(ws, { t: "authError", message: "Login failed. Please try again." });
      console.error("login error:", e);
    });
}

// Restore a session from a stored token on (re)connect — silent, no error if invalid.
function handleAuthenticate(ws, msg) {
  if (!authConfigured()) return; // silently stay anonymous
  const token = msg && msg.token;
  const payload = verifyToken(token);
  if (!payload) return; // bad/expired token — stay anonymous; client falls back to guest
  const db = getDb();
  db.user.findUnique({ where: { id: payload.userId } })
    .then((user) => {
      if (!user) return; // user deleted since token issued
      if (!user.playerId) ensurePlayerId(user); // lazy backfill on session restore
      ws.userId = user.id;
      ws.userName = user.displayName;
      ws.country = user.country || null;   // cached for seat display (Phase 4)
      ws.avatar = user.avatar || null;
      ws.level = levelFromXp(user.xp || 0); // cached for the in-game/lobby level badge (Phase 5)
      ws.authenticated = true;
      trackUserSocket(ws);                 // Phase 6 — index for friend pushes
      send(ws, {
        t: "authOk", token, userId: user.id, name: user.displayName, stats: statsOf(user),
        playerId: user.playerId || null, country: user.country || null, avatar: user.avatar || null,
      });
    })
    .catch((e) => console.error("authenticate error:", e));
}

function handleLogout(ws) {
  untrackUserSocket(ws); // Phase 6 — stop pushing friend notifications to this socket
  ws.userId = null;
  ws.userName = null;
  ws.country = null;   // clear cached seat identity (Phase 4)
  ws.avatar = null;
  ws.level = null;     // clear cached level badge (Phase 5)
  ws.authenticated = false;
  send(ws, { t: "loggedOut" });
}

// ---------- Phase 6: friends handlers ----------
// The shared select for the "other user" in a friendship edge (must be defined
// before replyFriends, which uses it).
const FRIEND_USER_SELECT = { id: true, displayName: true, playerId: true, avatar: true, country: true, xp: true };
// Shape a User row into the public friend-facing summary (id/name/avatar/country/
// player-id + derived level + online flag). Reused by getFriends + notifications.
function friendSummary(user) {
  if (!user) return null;
  return {
    userId: user.id,
    name: user.displayName || "Player",
    playerId: user.playerId || null,
    avatar: user.avatar || null,
    country: user.country || null,
    level: levelFromXp(user.xp || 0),
    online: isUserOnline(user.id),
  };
}
// Re-fetch + reply with the caller's friends + incoming requests. Fire this after
// any friend mutation so the client's list is immediately fresh.
function replyFriends(ws) {
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friends", list: [], requests: [] }); return; }
  db.user.findUnique({
    where: { id: ws.userId },
    // accepted edges where I'm either side + pending requests I RECEIVED.
    // NOTE: under `include`, a nested relation must be { select: {...} }, not a
    // bare { id:true, ... } object (Prisma rejects the bare form as invalid).
    select: {
      outgoing: { where: { status: "accepted" }, include: { friend: { select: FRIEND_USER_SELECT } } },
      incoming: { include: { user: { select: FRIEND_USER_SELECT } } },
    },
  })
    .then((me) => {
      if (!me) { send(ws, { t: "friends", list: [], requests: [] }); return; }
      // My friends: people I have an accepted outgoing edge to, OR people whose
      // accepted incoming edge points at me. (Either side = friends.)
      const list = [];
      const seen = new Set();
      for (const f of me.outgoing || []) {
        if (!seen.has(f.friend.id)) { seen.add(f.friend.id); list.push(friendSummary(f.friend)); }
      }
      const acceptedIncoming = (me.incoming || []).filter((f) => f.status === "accepted");
      for (const f of acceptedIncoming) {
        if (!seen.has(f.user.id)) { seen.add(f.user.id); list.push(friendSummary(f.user)); }
      }
      // Incoming PENDING requests = people who want to be my friend.
      const requests = (me.incoming || []).filter((f) => f.status === "pending")
        .map((f) => friendSummary(f.user));
      send(ws, { t: "friends", list, requests });
    })
    .catch((e) => { console.error("getFriends error:", e); send(ws, { t: "friends", list: [], requests: [] }); });
}

function handleGetFriends(ws) { return replyFriends(ws); }

function handleAddFriend(ws, msg) {
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friendError", error: "notAuthenticated" }); return; }
  const playerId = normalizePlayerId(msg && msg.playerId);
  if (!playerId) { send(ws, { t: "friendError", error: "invalidId" }); return; }
  db.user.findUnique({ where: { playerId } })
    .then(async (target) => {
      if (!target) { send(ws, { t: "friendError", error: "notFound" }); return; }
      if (target.id === ws.userId) { send(ws, { t: "friendError", error: "self" }); return; }
      // Already friends or a pending request either direction?
      const existing = await db.friendship.findFirst({
        where: {
          OR: [
            { userId: ws.userId, friendId: target.id },
            { userId: target.id, friendId: ws.userId },
          ],
        },
      });
      if (existing) {
        send(ws, { t: "friendError", error: existing.status === "accepted" ? "alreadyFriends" : "pending" });
        return;
      }
      await db.friendship.create({ data: { userId: ws.userId, friendId: target.id, status: "pending" } });
      send(ws, { t: "friendAdded", ok: true });
      // Push a live notification to the target if they're online (request pop-up).
      sendToUser(target.id, { t: "friendRequest", from: friendSummary({ id: ws.userId, displayName: ws.userName, xp: 0 }) });
      return replyFriends(ws);
    })
    .catch((e) => { console.error("addFriend error:", e); send(ws, { t: "friendError", error: "server" }); });
}

function handleAcceptFriend(ws, msg) {
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friendError", error: "notAuthenticated" }); return; }
  const otherId = msg && msg.userId;
  if (!otherId) { send(ws, { t: "friendError", error: "invalidId" }); return; }
  // Only the pending request WHERE I AM THE RECIPIENT can be accepted by me.
  db.friendship.updateMany({
    where: { userId: otherId, friendId: ws.userId, status: "pending" },
    data: { status: "accepted" },
  })
    .then((res) => {
      if (!res || res.count === 0) { send(ws, { t: "friendError", error: "notFound" }); return; }
      // Notify the requester their request was accepted (so their list refreshes).
      sendToUser(otherId, { t: "friendAccepted", from: friendSummary({ id: ws.userId, displayName: ws.userName, xp: 0 }) });
      return replyFriends(ws);
    })
    .catch((e) => { console.error("acceptFriend error:", e); send(ws, { t: "friendError", error: "server" }); });
}

function handleDeclineFriend(ws, msg) {
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friendError", error: "notAuthenticated" }); return; }
  const otherId = msg && msg.userId;
  if (!otherId) { send(ws, { t: "friendError", error: "invalidId" }); return; }
  // Decline a pending request addressed to me.
  db.friendship.deleteMany({ where: { userId: otherId, friendId: ws.userId, status: "pending" } })
    .then(() => replyFriends(ws))
    .catch((e) => { console.error("declineFriend error:", e); send(ws, { t: "friendError", error: "server" }); });
}

function handleRemoveFriend(ws, msg) {
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friendError", error: "notAuthenticated" }); return; }
  const otherId = msg && msg.userId;
  if (!otherId) { send(ws, { t: "friendError", error: "invalidId" }); return; }
  // Remove the edge regardless of direction or status (severs the link either way).
  db.friendship.deleteMany({
    where: {
      OR: [
        { userId: ws.userId, friendId: otherId },
        { userId: otherId, friendId: ws.userId },
      ],
    },
  })
    .then(() => replyFriends(ws))
    .catch((e) => { console.error("removeFriend error:", e); send(ws, { t: "friendError", error: "server" }); });
}

function handleInviteFriend(ws, msg) {
  // Live room invite: sender must be in a LOBBY-state private room with a code.
  const db = getDb();
  if (!db || !ws.authenticated || !ws.userId) { send(ws, { t: "friendError", error: "notAuthenticated" }); return; }
  const friendId = msg && msg.userId;
  if (!friendId) { send(ws, { t: "friendError", error: "invalidId" }); return; }
  const room = ws.room;
  const code = room && room.roomId;
  const inLobby = room && room.matchState === "LOBBY";
  if (!inLobby || !code) { send(ws, { t: "friendError", error: "notInRoom" }); return; }
  // Only invite accepted friends.
  db.friendship.findFirst({
    where: {
      status: "accepted",
      OR: [{ userId: ws.userId, friendId }, { userId: friendId, friendId: ws.userId }],
    },
  })
    .then((edge) => {
      if (!edge) { send(ws, { t: "friendError", error: "notFriends" }); return; }
      const delivered = sendToUser(friendId, {
        t: "friendInvite",
        from: friendSummary({ id: ws.userId, displayName: ws.userName, xp: 0 }),
        room: code,
        roomName: `Room ${code}`,
      });
      send(ws, { t: "friendInviteSent", ok: true, delivered });
    })
    .catch((e) => { console.error("inviteFriend error:", e); send(ws, { t: "friendError", error: "server" }); });
}

function handleJoin(ws, msg) {
  // Authenticated users reclaim their seat by their stable DB user id (cross-device);
  // anonymous guests keep today's behavior with a random sessionId.
  const sessionId = ws.userId || (msg && msg.sessionId) || crypto.randomBytes(6).toString("hex");
  ws.sessionId = sessionId;
  // Authenticated users' display name comes from their account (can't be spoofed);
  // guests use whatever they typed.
  const name = ws.userName || cleanName((msg && msg.name) || "") || "Player";
  const mode = (msg && msg.mode) || "quick";
  const requestedRoom = (msg && msg.roomId) || null;

  let room;
  if (mode === "private") {
    room = requestedRoom ? (getRoom(requestedRoom) || createRoom(requestedRoom, { privateRoom: true })) : createRoom(undefined, { privateRoom: true });
  } else {
    // Reconnect to an existing room where this sessionId is seated (any mode).
    const existing = [...rooms.values()].find(
      (r) => r.seats.some((s) => s.isHuman && s.sessionId === sessionId)
    );
    room = existing || findOpenRoom();
  }

  const seat = room.addHuman(ws, sessionId, name);
  if (seat === -1) {
    // Room full — try a fresh open room as a fallback.
    room = findOpenRoom();
    const seat2 = room.addHuman(ws, sessionId, name);
    if (seat2 === -1) { send(ws, { t: "error", message: "All rooms full. Try again." }); return; }
    ws.seat = seat2;
  } else {
    ws.seat = seat;
  }
  ws.room = room;

  // Lobby phase: keep clients in sync and schedule auto-start for quick-match.
  if (room.matchState === "LOBBY") {
    room.broadcastLobby();
    if (!room.privateRoom) scheduleFillStart(room);
  } else if (room.matchState === "LEAD_SELECT") {
    // Late joiner during the lead-selection ceremony: drop them INTO the ceremony
    // (face-up cards + banner), NOT the game. They must not see a "playing" view.
    room.sendLeadSelectEnter(ws.seat);
  } else if (room.matchState === "PLAYING") {
    // Mid-match join (reconnection) — sendInitTo already handled in onHumanReconnect.
    // If it's a brand-new seat taken over from a bot mid-match, re-sync:
    room.sendInitTo(ws.seat);
  } else if (room.matchState === "FINISHED") {
    send(ws, { t: "error", message: "Match already ended. Start a new one." });
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

server.listen(PORT, HOST, () => {
  console.log(`\n  ♠♥♦♣  Mega Mindikot 5v5  ♠♥♦♣`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Multi-room (quick-match fill: ${FILL_TIMER_MS}ms)`);
  console.log(`  Accounts: ${authConfigured() ? "enabled (Postgres + JWT)" : "disabled (guest-only)"}\n`);
});

// Close the DB connection pool cleanly on shutdown so the process exits promptly.
function shutdown() {
  closeDb().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
