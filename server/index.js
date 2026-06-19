// Mega Mendikot 5v5 — self-contained server.
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

const server = http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/" || url === "/index") url = "/index.html";
    if (url.includes("..")) { res.writeHead(403); return res.end("Forbidden"); }
    const filePath = join(CLIENT_DIR, url);
    const data = await readFile(filePath);
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
  const ws = { socket, readyState: 1, OPEN: 1, CLOSED: 3, _listeners: {}, sessionId: null, room: null, seat: null };
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

// Periodically clean up finished/idle rooms.
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.matchState === "FINISHED" || (room.matchState === "LOBBY" && room.humanCount() === 0)) {
      room.clearTimers();
      if (room._fillHandle) { clearTimeout(room._fillHandle); room._fillHandle = null; }
      rooms.delete(id);
    }
  }
}, 10000);

// --- Connection handling ---
wss.on("connection", (ws) => {
  send(ws, { t: "hello" });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    if (ws.room && ws.seat !== null) {
      ws.room.onHumanDisconnect(ws.seat);
      if (ws.room.matchState === "LOBBY") ws.room.broadcastLobby();
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.t) {
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
    case "chat":
      if (ws.room && ws.seat !== null) ws.room.onChatFromSeat(ws.seat, msg.text || "");
      break;
    case "voiceToggle":
      // Mute/unmute is client-local (the publishing client mutes its own mic
      // track); the server only relays the teammate-facing HUD state so others
      // see who's muted. Bot/spectator toggles are ignored.
      if (ws.room && ws.seat !== null && ws.room.matchState === "PLAYING") {
        const team = ws.room.seats[ws.seat] && ws.room.seats[ws.seat].team;
        if (team) {
          ws.room.broadcastToTeam(team, {
            t: "voiceState",
            seat: ws.seat,
            muted: !!msg.muted,
          });
        }
      }
      break;
    case "ping": send(ws, { t: "pong" }); break;
  }
}

function handleJoin(ws, msg) {
  const name = ((msg && msg.name) || "").toString().slice(0, 20) || "Player";
  const sessionId = (msg && msg.sessionId) || crypto.randomBytes(6).toString("hex");
  ws.sessionId = sessionId;
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
  console.log(`\n  ♠♥♦♣  Mega Mendikot 5v5  ♠♥♦♣`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Multi-room (quick-match fill: ${FILL_TIMER_MS}ms)\n`);
});
