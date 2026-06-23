// Mega Mindikot 5v5 — web client (no build step; vanilla JS)
"use strict";

const SUIT_GLYPH = { SPADES: "♠", HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣" };
const SUIT_COLOR = { SPADES: "black", HEARTS: "red", DIAMONDS: "red", CLUBS: "black" };
const RANK_NAME = { 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

// Must match the server's TURN_SECONDS (game-room.js §2.9). The client runs a
// decorative local countdown synced to this; the server is authoritative for
// the 0s auto-play and emits turnWarning at 5s.
const TURN_SECONDS = 20;

// 10 positions around the oval table. Index = visual slot (0=top, clockwise).
// Slot 5 is the bottom center — where "you" always sit.
const POS_FOR_10 = [
  [50, 2], [78, 12], [95, 38], [95, 62], [78, 88],
  [50, 98], [22, 88], [5, 62], [5, 38], [22, 12],
];

// Returns the visual [x%, y%] position for a given seat, rotated so that
// state.you always lands at slot 5 (bottom center). Each player sees the
// table from their own perspective.
function seatPos(seatIndex) {
  const you = state.you || 0;
  const slot = ((seatIndex - you + 5) % 10 + 10) % 10;
  return POS_FOR_10[slot];
}
// Returns the visual angle (degrees, clockwise from top) for a played card,
// aligned with seatPos so each card lands near its owner's icon.
function cardAngle(seatIndex) {
  const you = state.you || 0;
  const slot = ((seatIndex - you + 5) % 10 + 10) % 10;
  return slot * 36;
}

const $ = (id) => document.getElementById(id);

// Persistent session id so reconnects reclaim the same seat.
function getSessionId() {
  let id = sessionStorage.getItem("mm_sid");
  if (!id) { id = "c_" + Math.random().toString(36).slice(2, 12); sessionStorage.setItem("mm_sid", id); }
  return id;
}

// --- account auth token (localStorage = persists across tabs/sessions = cross-device) ---
function getToken() { return localStorage.getItem("mm_token"); }
function setToken(t) { if (t) localStorage.setItem("mm_token", t); else localStorage.removeItem("mm_token"); }

const state = {
  ws: null,
  you: null,
  seats: [],
  hand: [],
  trickNumber: 1,
  leadSuit: "",
  trumpSuit: "",
  activeSeat: -1,
  score: { A: 0, B: 0 },
  capturedTens: { A: [], B: [] }, // per-team per-suit captured 10s for the chip tracker
  tricksWon: { A: 0, B: 0 },
  turnTime: 20,
  turnWarningSeat: null,  // seat under 5s warning (ring flashes red)
  playedCards: [],
  winnerSeat: null,
  kittyActive: false,
  kittyLeft: 0,
  thinkingSeat: null,
  myTurn: false,
  myTeam: null,        // for team chat routing/display
  // --- Lead-selection ceremony (spec §2.4, visible) ---
  leadSelectActive: false,   // true while the ceremony is playing out
  leadSelectCards: {},       // seat -> {card} face-up selection card per seat
  leadSelectWinner: null,    // seat that won the ceremony (once decided)
  leadSelectActiveSeats: null, // seats dealt a card THIS round (for staggered reveal)
  chatLog: [],         // ephemeral chat messages for the current match
  // --- LiveKit voice (opt-in) ---
  // Voice is OFF by default. The user must click "Join Voice" to opt in
  // (which also triggers the browser's mic-permission prompt). Until they do,
  // no mic access is requested and no audio flows.
  voiceRoom: null,     // livekit.Room instance once connected
  voiceConnected: false,
  voiceMuted: false,
  voiceWanted: false,    // user has opted in this session (sticky across matches)
  voiceAvailable: false, // a token is available right now
  pendingVoice: null,    // { voiceUrl, voiceRoom, voiceToken } from the server
  voiceMutedSeats: {}, // seat -> bool (per-player mute indicators)
  // --- account auth (Phase 1) ---
  userId: null,
  userName: null,      // display name from the account (if logged in)
  token: getToken(),
  authenticated: false,
  authPending: null,   // deferred join waiting for auth to resolve
  // lobby
  room: null,
  hostSeat: null,
  pendingMode: null,
  pendingRoomId: null,
  pendingName: null,   // guest name to send with join
};

// Reset all per-match client state to a clean baseline. Called on every match
// teardown (leave, rematch, match-end) so a fresh match never inherits stale
// table/hand/ceremony data from the previous one. Preserves connection + auth
// fields (ws, token, userName) which survive across matches.
function resetMatchState() {
  state.hand = [];
  state.playedCards = [];
  state.score = { A: 0, B: 0 };
  state.tricksWon = { A: 0, B: 0 };
  state.capturedTens = { A: [], B: [] }; // chip tracker — clear so a fresh match shows nothing captured
  state.trickNumber = 1;
  state.leadSuit = "";
  state.trumpSuit = "";
  state.activeSeat = -1;
  state.winnerSeat = null;
  state.thinkingSeat = null;
  state.kittyActive = false;
  state.kittyLeft = 0;
  state.myTurn = false;
  // Ceremony — must be cleared or stale cards render over the next match.
  state.leadSelectActive = false;
  state.leadSelectCards = {};
  state.leadSelectWinner = null;
  state.leadSelectActiveSeats = null;
  hideLeadBanner();
  // Also clear the rendered table so old cards/scores don't linger visually.
  const table = $("table");
  if (table) table.innerHTML = "";
  const hand = $("hand");
  if (hand) hand.innerHTML = "";
}

// ---------- connection ----------
// Opens the socket. If we have a stored token, we authenticate first and defer
// the `join` until the server confirms (so an authenticated user reclaims by
// their stable DB id). Guests send join immediately on open.
function connect(name, opts = {}) {
  state.pendingMode = opts.mode || "quick";
  state.pendingRoomId = opts.roomId || null;
  state.pendingName = name;
  // A brand-new join must not inherit ceremony/game state from a previous match.
  // Clear everything so we start from a clean slate (lobby first, then start).
  state.leadSelectActive = false;
  state.leadSelectCards = {};
  state.leadSelectWinner = null;
  state.leadSelectActiveSeats = null;
  state.playedCards = [];
  state.hand = [];

  // If the existing socket (e.g. from signup/login) is open and authenticated,
  // reuse it — just send the join on it. Avoids duplicate-socket confusion.
  if (state.ws && state.ws.readyState === 1 && state.authenticated) {
    sendJoin(state.userName || name, state.pendingMode, state.pendingRoomId);
    return;
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => {
    if (state.token) {
      // Defer join until authenticate resolves; send it now.
      state.authPending = { name, mode: state.pendingMode, roomId: state.pendingRoomId };
      send({ t: "authenticate", token: state.token });
      // Safety fallback: if no authOk within 3s, proceed as guest.
      clearTimeout(state._authFallback);
      state._authFallback = setTimeout(() => {
        if (state.authPending) {
          const p = state.authPending; state.authPending = null;
          sendJoin(p.name, p.mode, p.roomId);
        }
      }, 3000);
    } else {
      sendJoin(name, state.pendingMode, state.pendingRoomId);
    }
  };
  state.ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  state.ws.onclose = () => {
    // Only auto-reconnect if we were in a game/lobby; otherwise back to menu.
    if (state.you !== null || state.room) {
      showMsg("Disconnected. Reconnecting…");
      setTimeout(() => connect(name, opts), 1500);
    }
  };
}

// Send the join message (extracted so auth can defer it).
function sendJoin(name, mode, roomId) {
  send({
    t: "join",
    name,
    mode,
    roomId,
    sessionId: getSessionId(),
  });
}

function send(obj) {
  if (window.__dbg) window.__dbg._out(obj);          // debug trace (no-op if debug not loaded)
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function handle(m) {
  if (window.__dbg) window.__dbg._in(m);              // debug trace (no-op if debug not loaded)
  switch (m.t) {
    case "hello": break;
    case "authOk": onAuthOk(m); break;
    case "authError": onAuthError(m); break;
    case "authDisabled": onAuthDisabled(m); break;
    case "loggedOut": onLoggedOut(); break;
    case "lobbyUpdate": onLobbyUpdate(m); break;
    case "leadSelectEnter": onLeadSelectEnter(m); break;
    case "leadSelect": onLeadSelect(m); break;
    case "init": onInit(m); break;
    case "trickStart": onTrickStart(m); break;
    case "played": onPlayed(m); break;
    case "trickWon": onTrickWon(m); break;
    case "botThinking": onBotThinking(m); break;
    case "trumpDeclared": state.trumpSuit = m.suit; renderHud(); break;
    case "turnWarning": state.turnWarningSeat = m.seat; renderSeats(); break;
    case "matchEnd": onMatchEnd(m); break;
    case "chat": onChat(m); break;
    case "voiceState": onVoiceState(m); break;
    case "lobbyVoice": offerVoice({ voiceUrl: m.voiceUrl, voiceRoom: m.voiceRoom, voiceToken: m.voiceToken }); break;
    case "voiceEnd": disconnectVoice(); break;
    case "error": showMsg(m.message); break;
  }
}

// ---------- account auth (Phase 1) ----------
function onAuthOk(m) {
  state.token = m.token;
  state.userId = m.userId;
  state.userName = m.name;
  state.authenticated = true;
  setToken(m.token);
  clearTimeout(state._authFallback);
  // If we were waiting to join (connect deferred auth), send the join now.
  if (state.authPending) {
    const p = state.authPending; state.authPending = null;
    sendJoin(p.name, p.mode, p.roomId);
  }
  refreshAuthUI();
  // Switch back to the join screen so the user sees they're signed in.
  showScreen("join-screen");
  showMsg(`Welcome, ${state.userName}!`);
}

function onAuthError(m) {
  // A failed login/signup attempt from the auth screen.
  showAuthMsg(m.message || "Authentication failed.");
}

function onAuthDisabled(m) {
  // Server has accounts off (no DB/JWT configured). Drop any pending token,
  // proceed as guest, and tell the user.
  setToken(null);
  state.token = null;
  state.authenticated = false;
  clearTimeout(state._authFallback);
  if (state.authPending) {
    const p = state.authPending; state.authPending = null;
    sendJoin(p.name, p.mode, p.roomId);
  }
  showAuthMsg(m.message || "Accounts aren't enabled on this server.");
}

function onLoggedOut() {
  setToken(null);
  state.token = null;
  state.userId = null;
  state.userName = null;
  state.authenticated = false;
  refreshAuthUI();
  showScreen("join-screen");
}

// Send a signup request over an open socket. Opens one if needed.
function doSignup(email, password, name) {
  openAuthSocketIfNeeded();
  send({ t: "signup", email, password, name });
}
function doLogin(email, password) {
  openAuthSocketIfNeeded();
  send({ t: "login", email, password });
}
function doLogout() {
  if (state.ws && state.ws.readyState === 1) send({ t: "logout" });
  else onLoggedOut();
}

// The auth screen uses its own short-lived socket (not the game connect()).
function openAuthSocketIfNeeded() {
  if (state.ws && state.ws.readyState === 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
}

// ---------- lobby ----------
function onLobbyUpdate(m) {
  // Ignore lobby updates once the match has started (we're on the game screen).
  if (m.matchState && m.matchState !== "LOBBY") return;
  state.room = m.room;
  state.hostSeat = m.hostSeat;
  state.seats = m.seats;
  if (state.you === null) state.you = findMySeat(m.seats);
  showScreen("lobby-screen");
  $("lobby-code").textContent = m.room;
  const linkWrap = $("lobby-link-wrap");
  if (m.privateRoom) {
    const url = `${location.origin}/?room=${m.room}`;
    linkWrap.innerHTML = `Share: <a href="${url}" style="color:var(--gold)">${url}</a>`;
  } else {
    linkWrap.textContent = "Quick match — bots fill empty seats shortly.";
  }
  // Render seats
  const host = $("lobby-seats");
  host.innerHTML = "";
  m.seats.forEach((s) => {
    const el = document.createElement("div");
    const label = s.isBot ? "Waiting…" : `${s.name}${s.seat === state.you ? " (You)" : ""}${s.seat === m.hostSeat ? " 👑" : ""}`;
    el.className = `lobby-seat team-${s.team.toLowerCase()}${s.isBot ? " empty" : ""}`;
    el.innerHTML = `<span class="ls-dot"></span><span>${label}</span>`;
    host.appendChild(el);
  });
  // Host controls
  const isHost = state.you === m.hostSeat;
  $("lobby-start-btn").classList.toggle("hidden", !isHost);
  $("lobby-waiting").classList.toggle("hidden", isHost);
}

function findMySeat(seats) {
  // We don't know our seat from lobby alone; match by nothing available yet.
  // The server tells us via init.you once the game starts. For lobby display
  // we approximate "you" by matching our name against seats.
  const name = $("name-input").value.trim();
  const me = seats.find((s) => !s.isBot && s.name === (name || "Player"));
  return me ? me.seat : null;
}

// ---------- lead-selection ceremony (spec §2.4, visible) ----------
// Server tells us to show the game table (empty) so the ceremony can play out.
function onLeadSelectEnter(m) {
  state.you = m.you;
  state.seats = m.seats;
  const me = m.seats.find((s) => s.seat === m.you);
  state.myTeam = me ? me.team : null;
  state.leadSelectActive = true;
  state.leadSelectCards = {};
  state.leadSelectWinner = null;
  state.leadSelectActiveSeats = null;
  state.hand = [];            // no hand dealt yet
  state.score = { A: 0, B: 0 };
  state.tricksWon = { A: 0, B: 0 };
  state.trickNumber = 1;
  showScreen("game-screen");
  renderSeats();
  renderHand();
  showLeadBanner("Determining first lead…");
}

// A round of selection cards (face-up), or the final winner.
function onLeadSelect(m) {
  if (m.winner !== undefined && m.winner !== null) {
    // Ceremony decided — highlight the winner, then the real deal (init) follows.
    state.leadSelectWinner = m.winner;
    state.leadSelectActiveSeats = null;
    renderSeats();
    const wc = m.winnerCard;
    showLeadBanner(`Seat ${m.winner + 1} leads with ${RANK_NAME[wc.rank]}${SUIT_GLYPH[wc.suit]}`);
    return;
  }
  // A round of cards. allCards carries every currently-visible selection card so
  // we can dim the eliminated ones on shootout rounds. activeSeats tells us which
  // seats got a NEW card this round (those reveal one-at-a-time, staggered).
  const map = {};
  for (const c of (m.allCards || m.cards)) map[c.seat] = { card: c.card };
  state.leadSelectCards = map;
  state.leadSelectActiveSeats = m.activeSeats || Object.keys(map).map(Number);
  renderSeats();
  const label = m.round === 1
    ? `Lead selection — dealing cards…`
    : `Shootout — ${m.activeSeats.length} players tied (round ${m.round})`;
  showLeadBanner(label);
}

// ---------- game state handlers ----------
function onInit(m) {
  state.you = m.you;
  state.seats = m.seats;
  state.hand = m.hand;
  state.trickNumber = m.trickNumber;
  state.leadSuit = m.leadSuit;
  state.trumpSuit = m.trumpSuit;
  state.activeSeat = m.activeSeat;
  state.score = m.score;
  if (m.capturedTens) state.capturedTens = m.capturedTens;
  if (m.tricksWon) state.tricksWon = m.tricksWon;
  state.turnTime = m.turnTime;
  state.playedCards = m.playedCards || [];
  state.kittyActive = !!m.kittyActive;
  state.kittyLeft = m.kittyLeft;
  state.thinkingSeat = null;
  // Real hand has arrived — tear down the lead-selection ceremony.
  state.leadSelectActive = false;
  state.leadSelectCards = {};
  state.leadSelectWinner = null;
  hideLeadBanner();
  // Derive our team for chat display
  const me = m.seats.find((s) => s.seat === m.you);
  state.myTeam = me ? me.team : null;
  state.chatLog = []; // fresh chat per match
  showScreen("game-screen");
  showChatPanel(true);
  renderSeats();
  renderHand();
  renderHud();
  renderPlayedCards();
  renderKitty();
  // Match-only voice: offer the token; the client connects only if the user
  // has opted in this session (voiceWanted). See offerVoice().
  offerVoice({ voiceUrl: m.voiceUrl, voiceRoom: m.voiceRoom, voiceToken: m.voiceToken });
}

function onTrickStart(m) {
  state.trickNumber = m.trickNumber;
  state.playedCards = [];
  state.winnerSeat = null;
  state.thinkingSeat = null;
  state.activeSeat = m.leadSeat;
  state.leadSuit = "";
  if (m.kittyActive !== undefined) state.kittyActive = !!m.kittyActive;
  if (m.kittyLeft !== undefined) state.kittyLeft = m.kittyLeft;
  renderHud();
  renderKitty();
  renderSeats();
  updateMyTurn();
}

function onPlayed(m) {
  state.playedCards.push({ seat: m.seat, card: m.card, playOrder: m.playOrder });
  if (state.playedCards.length === 1) state.leadSuit = m.card.suit;
  if (m.seat === state.you) {
    state.hand = state.hand.filter((c) => c.id !== m.card.id);
    renderHand();
  }
  state.activeSeat = nextSeat(m.seat);
  state.thinkingSeat = null;
  renderPlayedCards();
  renderHud();
  renderSeats();
  updateMyTurn();
}

function onTrickWon(m) {
  state.score = m.score;
  if (m.capturedTens) state.capturedTens = m.capturedTens;
  if (m.tricksWon) state.tricksWon = m.tricksWon;
  state.winnerSeat = m.winnerSeat;
  state.thinkingSeat = null;
  if (m.kittyCard) {
    flipKitty(m.kittyCard);
    showMsg(`Kitty revealed: ${m.kittyCard.label} → Team ${m.team} (+${m.tens} tens)`);
  } else {
    showMsg(`Trick ${m.trickNumber} → Team ${m.team} (+${m.tens} tens)`);
  }
  $("score-a").textContent = state.score.A;
  $("score-b").textContent = state.score.B;
  renderSeats();
  renderHud();
}

function onBotThinking(m) {
  state.thinkingSeat = m.seat;
  renderSeats();
}

// ---------- team chat ----------
function onChat(m) {
  state.chatLog.push({ seat: m.seat, name: m.name, team: m.team, text: m.text });
  renderChat();
}

function renderChat() {
  const log = $("chat-log");
  if (!log) return;
  log.innerHTML = "";
  state.chatLog.forEach((msg) => {
    const row = document.createElement("div");
    const teamClass = msg.team === "A" ? "team-a" : "team-b";
    const teamColor = msg.team === "A" ? "var(--teamA)" : "var(--teamB)";
    const isMe = msg.seat === state.you;
    row.className = `chat-row ${teamClass}`;
    row.innerHTML = `<span class="chat-name" style="color:${teamColor}">${isMe ? "You" : msg.name}:</span> <span class="chat-text">${msg.text}</span>`;
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight; // auto-scroll to latest
}

function sendChat() {
  const input = $("chat-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  send({ t: "chat", text });
  input.value = "";
}

// ---------- voice (LiveKit, opt-in) ----------
// The LiveKit browser SDK is vendored (client/livekit-client.umd.min.js); the
// server stays zero-dependency. Voice is OPT-IN: the server sends a voiceToken,
// but the client does NOT auto-connect. The user must click "Join Voice", which
// records voiceWanted=true (sticky for the session) and triggers connectVoice.
// A failed mic permission, a missing token, or an unreachable SFU must NEVER
// break the game — every path degrades to silent.
const LIVEKIT = typeof window !== "undefined" ? window.livekit : undefined;

// Store the latest token from the server and connect only if the user has
// already opted in for this session (e.g. they joined voice in a prior match
// and are now in a new match/lobby). This keeps voice opt-in but sticky.
function offerVoice(voice) {
  if (!voice || !voice.voiceToken) {
    state.pendingVoice = null;
    state.voiceAvailable = false;
  } else {
    state.pendingVoice = voice;
    state.voiceAvailable = true;
  }
  if (state.voiceWanted && state.voiceAvailable && !state.voiceConnected) {
    connectVoice(state.pendingVoice);
  }
  updateVoiceButton();
}

async function connectVoice(voice) {
  if (!voice || !voice.voiceToken) return;       // voice not configured server-side
  if (!LIVEKIT) { showMsg("Voice unavailable (SDK not loaded)."); return; }
  if (state.voiceRoom) { await disconnectVoice(); }
  try {
    const room = new LIVEKIT.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
    });
    await room.connect(voice.voiceUrl, voice.voiceToken, { autoSubscribe: true });
    state.voiceRoom = room;
    state.voiceConnected = true;
    state.voiceMuted = false;
    // Publish the mic. The browser shows its native permission prompt here; a
    // denial rejects and we catch it below (game keeps running, voice is off).
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (micErr) {
      showMsg("🎙️ Mic blocked — voice is listen-only.");
      state.voiceMuted = true;
    }
    updateVoiceButton();
    showMsg(`🎙️ Voice connected`);
  } catch (err) {
    // SFU unreachable, bad token, network failure, etc. Fail soft.
    state.voiceRoom = null;
    state.voiceConnected = false;
    updateVoiceButton();
    showMsg("Voice could not connect. Game continues.");
    if (typeof console !== "undefined") console.warn("LiveKit connect failed:", err);
  }
}

async function disconnectVoice() {
  const room = state.voiceRoom;
  state.voiceRoom = null;
  state.voiceConnected = false;
  state.voiceMutedSeats = {};
  updateVoiceButton();
  if (room) {
    try { await room.disconnect(); } catch (e) { /* already gone */ }
  }
}

// Explicit opt-out: the user leaves voice AND stops auto-joining in future
// matches/lobbies. They can re-join any time via the Join Voice button.
async function leaveVoice() {
  state.voiceWanted = false;
  await disconnectVoice();
  showMsg("Left voice.");
}

async function toggleVoiceMute() {
  if (!state.voiceRoom) return;
  const next = !state.voiceMuted;
  try {
    await state.voiceRoom.localParticipant.setMicrophoneEnabled(!next);
    state.voiceMuted = next;
    send({ t: "voiceToggle", muted: next });
    updateVoiceButton();
  } catch (err) {
    showMsg("Mic toggle failed.");
  }
}

function onVoiceState(m) {
  state.voiceMutedSeats[m.seat] = !!m.muted;
  renderSeats();
}

// User clicked the voice button. Behavior depends on state:
//   - Not connected, token available → join voice (opt in).
//   - Connected → toggle mute.
// (Right-click / long-press → leave voice entirely; see the contextmenu handler.)
function onVoiceButtonClick() {
  if (state.voiceConnected) {
    toggleVoiceMute();
  } else if (state.voiceAvailable) {
    state.voiceWanted = true;
    connectVoice(state.pendingVoice);
  }
}

function updateVoiceButton() {
  // Update BOTH the in-game and the lobby voice buttons so the mic control
  // reflects the same state wherever the player is.
  const btns = ["voice-toggle", "lobby-voice-toggle"]
    .map((id) => $(id))
    .filter((b) => b);
  if (btns.length === 0) return;
  for (const btn of btns) {
    if (state.voiceConnected) {
      btn.classList.remove("hidden");
      btn.textContent = state.voiceMuted ? "🔇" : "🎙️";
      btn.setAttribute("aria-pressed", String(state.voiceMuted));
      btn.title = "Click to mute/unmute · Right-click to leave voice";
    } else if (state.voiceAvailable) {
      btn.classList.remove("hidden");
      btn.textContent = "🎙️+";
      btn.setAttribute("aria-pressed", "false");
      btn.title = "Join voice chat";
    } else {
      btn.classList.add("hidden");
      btn.setAttribute("aria-pressed", "false");
    }
  }
}

function showChatPanel(show) {
  const panel = $("chat-panel");
  const toggle = $("chat-toggle");
  if (!panel) return;
  if (show) {
    const label = panel.querySelector(".chat-team-label");
    if (label && state.myTeam) {
      label.textContent = `(Team ${state.myTeam})`;
      label.style.color = state.myTeam === "A" ? "var(--teamA)" : "var(--teamB)";
    }
    // On desktop show the panel + hide the toggle. On mobile, show the toggle
    // and keep the panel hidden until tapped.
    const isMobile = window.matchMedia("(max-width: 600px)").matches;
    if (isMobile) {
      toggle.classList.remove("hidden");
      panel.classList.add("hidden");
    } else {
      toggle.classList.add("hidden");
      panel.classList.remove("hidden");
    }
  } else {
    panel.classList.add("hidden");
    if (toggle) toggle.classList.add("hidden");
  }
}

function onMatchEnd(m) {
  disconnectVoice(); // tear down LiveKit audio on match end (server also emits voiceEnd)
  stopTurnCountdown(); // stop the decorative turn-timer ring
  state.activeSeat = -1;
  const me = m.seats.find((s) => s.seat === state.you);
  const title = $("end-title");
  const scoreLine = $("end-score");
  const tricks = m.tricksWon ? ` (tricks ${m.tricksWon.A}–${m.tricksWon.B})` : "";
  if (m.draw || !m.winningTeam) {
    // 12-12 deadlock where tricks were also tied — a genuine draw, no winner.
    title.textContent = "🤝 Draw";
    title.style.color = "var(--gold)";
    scoreLine.textContent = `Draw  ·  12–12 tied${tricks ? ` on tricks too` : ""}  ${tricks}`;
  } else if (m.deadlock) {
    // 12-12 deadlock resolved by most tricks — explain WHY this team won despite the tie.
    const myTeamWon = me && me.team === m.winningTeam;
    title.textContent = myTeamWon ? "🎉 You Win!" : "💀 You Lost";
    title.style.color = myTeamWon ? "var(--gold)" : "var(--red)";
    scoreLine.textContent = `Team ${m.winningTeam} wins on tricks  ·  A 12 – 12 B${tricks}`;
  } else {
    const myTeamWon = me && me.team === m.winningTeam;
    title.textContent = myTeamWon ? "🎉 You Win!" : "💀 You Lost";
    title.style.color = myTeamWon ? "var(--gold)" : "var(--red)";
    scoreLine.textContent = `Team ${m.winningTeam} wins  ·  A ${m.score.A} – ${m.score.B} B`;
  }
  const bd = $("end-breakdown");
  bd.innerHTML = "<h3 style='margin:14px 0 8px;font-size:14px;color:var(--muted)'>Tens captured</h3>";
  m.seats.sort((a, b) => a.seat - b.seat).forEach((s) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px;";
    const tag = s.seat === state.you ? " (You)" : "";
    row.innerHTML = `<span>${s.name}${tag} <span class="dot ${s.team === "A" ? "a" : "b"}" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:var(${s.team === "A" ? "--teamA" : "--teamB"})"></span></span><b>${s.tens}</b>`;
    bd.appendChild(row);
  });
  showScreen("end-screen");
  // The match is over — clear the in-progress game/ceremony state so a
  // subsequent match (via rematch or leave→new game) starts from a clean slate.
  resetMatchState();
}

// ---------- rendering ----------
function showScreen(id) {
  ["join-screen", "auth-screen", "lobby-screen", "game-screen", "end-screen"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  // The in-match "?" help button is only relevant while playing.
  const help = $("game-help-btn");
  if (help) help.classList.toggle("hidden", id !== "game-screen");
}

// ---------- auth UI helpers (Phase 1) ----------
// Reflects login state on the main menu: shows the logged-in name + logout, or
// the "Log in / Sign up" buttons for guests.
function refreshAuthUI() {
  const welcome = $("auth-welcome");
  const guestActions = $("auth-guest-actions");
  if (state.authenticated && state.userName) {
    if (welcome) {
      welcome.classList.remove("hidden");
      welcome.innerHTML = `Signed in as <b>${state.userName}</b> · <a href="#" id="logout-link">Log out</a>`;
      const link = $("logout-link");
      if (link) link.addEventListener("click", (e) => { e.preventDefault(); doLogout(); });
    }
    if (guestActions) guestActions.classList.add("hidden");
    // Always set the name field to the account name (don't leave a stale guest name).
    const nameInput = $("name-input");
    if (nameInput) nameInput.value = state.userName;
  } else {
    if (welcome) welcome.classList.add("hidden");
    if (guestActions) guestActions.classList.remove("hidden");
  }
}

function showAuthMsg(text) {
  const bar = $("auth-msg");
  if (!bar) { showMsg(text); return; }
  bar.textContent = text;
  bar.classList.remove("hidden");
  clearTimeout(showAuthMsg._t);
  showAuthMsg._t = setTimeout(() => bar.classList.add("hidden"), 4000);
}

// Toggle the auth form between login and signup modes.
function setAuthMode(mode) {
  const isSignup = mode === "signup";
  const nameField = $("auth-name-wrap");
  if (nameField) nameField.classList.toggle("hidden", !isSignup);
  const btn = $("auth-submit-btn");
  if (btn) btn.textContent = isSignup ? "Create account" : "Log in";
  const toggle = $("auth-mode-toggle");
  if (toggle) toggle.innerHTML = isSignup
    ? `Already have an account? <a href="#" id="auth-switch">Log in</a>`
    : `New here? <a href="#" id="auth-switch">Sign up</a>`;
  const sw = $("auth-switch");
  if (sw) sw.addEventListener("click", (e) => { e.preventDefault(); setAuthMode(isSignup ? "login" : "signup"); });
  if ($("auth-msg")) $("auth-msg").classList.add("hidden");
}

function renderSeats() {
  const table = $("table");
  table.querySelectorAll(".seat").forEach((el) => el.remove());
  state.seats.forEach((s) => {
    const [x, y] = seatPos(s.seat);
    const el = document.createElement("div");
    el.className = `seat team-${s.team.toLowerCase()}` + (s.seat === state.you ? " me" : "") + (s.seat === state.activeSeat ? " active" : "");
    el.style.left = x + "%";
    el.style.top = y + "%";
    const initials = (s.name || "?").slice(0, 2).toUpperCase();
    const thinking = s.seat === state.thinkingSeat;
    // Per-seat voice indicator intentionally removed — the top-right mic toggle
    // is the single source of truth, and glyphs on all 10 seats added clutter
    // (especially with all-player voice). The mute-state broadcast machinery
    // (voiceState/voiceToggle) is retained for potential future speaking-active use.
    // Turn-timer ring: only on the active seat. The progress circle is driven by
    // state.turnTime via renderTimerRing() (updated each second by the countdown).
    const timerRing = s.seat === state.activeSeat ? timerRingSvg(s.seat) : "";
    // Lead-selection card (ceremony): face-up under the avatar while the
    // pre-game draw plays out. Winner glows gold; eliminated/out cards dim.
    let leadCardHtml = "";
    // HARD GUARD: the ceremony never renders once the real game is live.
    // If we have a hand or played cards, the match is in PLAYING — drop any
    // stale/late ceremony state and skip lead-card rendering entirely. This
    // catches races where a ceremony broadcast arrives after `init`.
    if (state.leadSelectActive && (state.hand.length || (state.playedCards && state.playedCards.length))) {
      state.leadSelectActive = false;
      state.leadSelectCards = {};
      state.leadSelectWinner = null;
      hideLeadBanner();
    }
    if (state.leadSelectActive) {
      const lc = state.leadSelectCards[s.seat];
      if (lc) {
        const isWinner = state.leadSelectWinner === s.seat;
        const decided = state.leadSelectWinner !== null;  // ceremony is over
        // activeSeats = seats that got a NEW card this round. Each reveals
        // one-at-a-time, staggered by seat order (reveal-0, reveal-1, ...).
        // Seats NOT in the active set (eliminated in an earlier shootout round)
        // keep showing their old card, dimmed (.out).
        const active = state.leadSelectActiveSeats;
        const isActive = !active || active.includes(s.seat);
        const revealIdx = active ? active.indexOf(s.seat) : s.seat;
        let cls = "lead-card" + (SUIT_COLOR[lc.card.suit] === "red" ? " red" : "");
        if (isWinner) {
          cls += " winner";               // gold glow + pop
        } else if (decided) {
          cls += " settled";              // ceremony decided: just visible, no re-flip
        } else if (isActive) {
          cls += ` reveal-${Math.min(revealIdx, 9)}`;
        } else {
          cls += " out";                  // eliminated in a shootout: dimmed
        }
        leadCardHtml = `<div class="${cls}"><span class="lc-rank">${RANK_NAME[lc.card.rank]}</span><span class="lc-suit">${SUIT_GLYPH[lc.card.suit]}</span></div>`;
      }
    }
    el.innerHTML = `
      <div class="avatar">${initials}${timerRing}</div>
      ${leadCardHtml}
      <div class="name">${s.seat === state.you ? "You" : s.name}</div>
      ${thinking ? '<div class="meta"><span class="thinking-dots"><span></span><span></span><span></span></span></div>' : ''}`;
    table.appendChild(el);
  });
  renderTimerRing();
}

// SVG progress ring drawn around the active seat's avatar. r=25 fits a 46px
// avatar (the circle sits just inside its border). stroke-dashoffset animates
// from 0 (full) to circumference (empty) as the timer counts down.
const TIMER_R = 25;
const TIMER_C = 2 * Math.PI * TIMER_R; // circumference (~157)
function timerRingSvg(seat) {
  const warn = state.turnWarningSeat === seat ? " warn" : "";
  // stroke-dashoffset is set live by renderTimerRing; start full here.
  return `<svg class="timer-ring${warn}" viewBox="0 0 56 56" aria-hidden="true">
    <circle cx="28" cy="28" r="${TIMER_R}" class="timer-ring-track" />
    <circle cx="28" cy="28" r="${TIMER_R}" class="timer-ring-fill"
      stroke-dasharray="${TIMER_C}" stroke-dashoffset="0" />
  </svg>`;
}

// Update just the ring's progress + warning class without re-rendering seats.
function renderTimerRing() {
  const seatsHost = $("table");
  if (!seatsHost) return;
  const ring = seatsHost.querySelector(".seat.active .timer-ring");
  if (!ring) return;
  const frac = Math.max(0, Math.min(1, state.turnTime / TURN_SECONDS));
  const fill = ring.querySelector(".timer-ring-fill");
  if (fill) fill.style.strokeDashoffset = String(TIMER_C * (1 - frac));
  // Flash red in the final 5 seconds (matches the server's turnWarning at 5s).
  const warn = (state.turnWarningSeat === state.activeSeat) || state.turnTime <= 5;
  ring.classList.toggle("warn", !!warn);
}

// Mirror of the server's resolveTrickWinner (spec §2.7): determines which
// played card is currently winning the trick, for live highlighting.
function computeWinningSeat() {
  if (!state.playedCards.length) return null;
  const lead = state.leadSuit, trump = state.trumpSuit;
  const pool = trump
    ? state.playedCards.filter((p) => p.card.suit === trump)
    : state.playedCards.filter((p) => p.card.suit === lead);
  const final = pool.length ? pool : state.playedCards.filter((p) => p.card.suit === lead);
  const arr = final.length ? final : state.playedCards;
  let maxRank = -1;
  for (const p of arr) if (p.card.rank > maxRank) maxRank = p.card.rank;
  const top = arr.filter((p) => p.card.rank === maxRank);
  let win = top[0];
  for (let i = 1; i < top.length; i++) if (top[i].playOrder > win.playOrder) win = top[i];
  return win ? win.seat : null;
}

function renderPlayedCards() {
  const host = $("played-cards");
  if (!host) return;
  host.innerHTML = "";
  const winningSeat = state.winnerSeat !== null ? state.winnerSeat : computeWinningSeat();
  state.playedCards.forEach((p) => {
    // Each card sits between its own seat and the table center, rotated for your view.
    const angle = cardAngle(p.seat);
    const radius = 115;
    const rad = (angle - 90) * Math.PI / 180;
    const dx = Math.cos(rad) * radius;
    const dy = Math.sin(rad) * radius;
    const isTrump = state.trumpSuit && p.card.suit === state.trumpSuit;
    const isWinning = p.seat === winningSeat;
    const el = document.createElement("div");
    el.className = "table-card" + (SUIT_COLOR[p.card.suit] === "red" ? " red" : "") + (isWinning ? " winning" : "") + (isTrump ? " trump" : "");
    el.style.transform = `translate(${dx}px, ${dy}px)`; // keep cards upright — no rotation
    el.innerHTML = `
      <div class="tc-rank">${RANK_NAME[p.card.rank]}</div>
      <div class="tc-suit">${SUIT_GLYPH[p.card.suit]}</div>
      ${isTrump ? '<div class="tc-badge trump-badge">TRUMP</div>' : ''}
      ${isWinning ? '<div class="tc-badge win-badge">WINNING</div>' : ''}`;
    host.appendChild(el);
  });
}

function clearCenterCards() {
  state.playedCards = [];
  renderPlayedCards();
}

// Kitty card: shown face-down during the trick, flipped face-up on reveal.
function renderKitty() {
  const display = $("kitty-display");
  const card = $("kitty-card");
  const count = $("kitty-count");
  if (!display) return;
  if (state.kittyActive) {
    display.classList.remove("hidden");
    card.classList.remove("revealed");
    const front = card.querySelector(".kitty-front");
    front.className = "kitty-face kitty-front";
    front.innerHTML = "";
    count.textContent = state.kittyLeft > 0 ? `${state.kittyLeft} left` : "";
  } else {
    display.classList.add("hidden");
  }
}
function flipKitty(kittyCard) {
  const card = $("kitty-card");
  if (!card) return;
  const front = card.querySelector(".kitty-front");
  const isTen = kittyCard.rank === 10;
  const isRed = SUIT_COLOR[kittyCard.suit] === "red";
  front.className = "kitty-face kitty-front" + (isRed ? " red" : "") + (isTen ? " is-ten" : "");
  front.innerHTML = `<div>${RANK_NAME[kittyCard.rank]}</div><div>${SUIT_GLYPH[kittyCard.suit]}</div>`;
  card.classList.add("revealed");
}

function renderHand() {
  const hand = $("hand");
  hand.innerHTML = "";
  const sorted = state.hand.slice().sort((a, b) => {
    const order = { SPADES: 0, HEARTS: 1, CLUBS: 2, DIAMONDS: 3 };
    if (order[a.suit] !== order[b.suit]) return order[a.suit] - order[b.suit];
    return b.rank - a.rank;
  });
  const myTurn = state.myTurn;
  // The hand label reflects whose turn it is so the player knows whether clicking
  // will play a card or just inspect.
  const label = $("hand-label");
  if (label) label.textContent = myTurn ? "Your turn — click a playable card" : "Your hand (waiting for your turn)";

  let prevSuit = null;
  sorted.forEach((card) => {
    const el = document.createElement("div");
    const playable = myTurn && isPlayable(card);
    const isTenCard = card.rank === 10;
    // Class logic separates "inspectable" from "playable":
    //  - .disabled = not playable THIS turn (illegal, or not your turn). Still
    //    hover-inspectable unless explicitly locked (see CSS).
    //  - .playable = legal AND your turn -> clickable.
    //  - .is-ten = objective card, always highlighted.
    let cls = "card" + (SUIT_COLOR[card.suit] === "red" ? " red" : "");
    cls += playable ? " playable" : " disabled";
    if (isTenCard) cls += " is-ten";
    // Open a new suit group with an extra left margin so the hand clusters into
    // 4 visible piles (♠ ♥ ♦ ♣) instead of one uniform fan.
    if (prevSuit !== null && card.suit !== prevSuit) cls += " suit-break";
    prevSuit = card.suit;
    el.className = cls;
    el.innerHTML = `<div class="rank">${RANK_NAME[card.rank]}</div><div class="suit">${SUIT_GLYPH[card.suit]}</div>`;
    if (playable) el.addEventListener("click", () => playCard(card.id));
    hand.appendChild(el);
  });
}

function renderHud() {
  $("score-a").textContent = state.score.A;
  $("score-b").textContent = state.score.B;
  // Live tricks-won counter (the 12-12 deadlock tiebreak). Falls back to 0
  // gracefully if the server (or an older state message) omits tricksWon.
  const tw = state.tricksWon || { A: 0, B: 0 };
  $("tricks-a").textContent = tw.A;
  $("tricks-b").textContent = tw.B;
  $("trick-num").textContent = state.trickNumber;
  const td = $("trump-display");
  if (state.trumpSuit) {
    td.textContent = SUIT_GLYPH[state.trumpSuit];
    td.style.color = SUIT_COLOR[state.trumpSuit] === "red" ? "var(--red)" : "#fff";
    td.style.opacity = "1";
  } else {
    // No trump established yet — empty value (no dash placeholder).
    td.textContent = "";
    td.style.color = "var(--muted)";
    td.style.opacity = "0";
  }
  const leadInfo = $("lead-info");
  const leadDisp = $("lead-display");
  if (leadInfo && leadDisp) {
    // Keep the Lead chip always visible — popping it in/out between tricks shifts
    // the center layout and is jarring. Before a lead suit exists (start of a
    // trick, before any card is played) show a muted "—" placeholder; once the
    // first card lands, show its suit glyph in the suit's color.
    leadInfo.classList.remove("hidden");
    if (state.leadSuit) {
      leadDisp.textContent = SUIT_GLYPH[state.leadSuit];
      leadDisp.style.color = SUIT_COLOR[state.leadSuit] === "red" ? "var(--red)" : "#fff";
      leadDisp.style.opacity = "1";
    } else {
      leadDisp.textContent = "—";
      leadDisp.style.color = "var(--muted)";
      leadDisp.style.opacity = "0.6";
    }
  }
  renderTensTracker();
  renderSeats();
}

// ---------- captured-10s chip tracker ----------
// Two per-team trackers: one inside Team A's score panel, one inside Team B's.
// Each shows the Tens THAT team has captured — 4 rows (one per suit) x 6 chips
// (6 copies of the 10 per suit in the 192-card mega deck). Captured chips take
// the team's own color (via .score.team-x .tens-chip.captured); empty = still
// live. The server is the source of truth (state.capturedTens = { A:[{suit}],
// B:[{suit}] }), so a mid-match reconnect shows the right history. A tracker
// stays hidden until that team captures its first Ten.
const SUITS_ORDER = ["SPADES", "HEARTS", "DIAMONDS", "CLUBS"];
const COPIES_PER_SUIT = 6;

function renderTensTracker() {
  // Render one team's tracker. `team` is "A" or "B".
  function renderTeam(team, wrap) {
    if (!wrap) return;
    // Count how many of each suit THIS team has captured.
    const perSuit = {};
    for (const suit of SUITS_ORDER) perSuit[suit] = 0;
    for (const c of (state.capturedTens[team] || [])) {
      if (perSuit[c.suit] !== undefined) perSuit[c.suit]++;
    }
    // Always render the full 4x6 grid so both team panels stay the same height
    // and the score bar stays vertically aligned. Empty chips (dashed) mark
    // uncaptured copies; captured chips take the team color (via .captured).
    wrap.classList.remove("hidden");
    let html = "";
    for (const suit of SUITS_ORDER) {
      const color = SUIT_COLOR[suit] === "red" ? "var(--red)" : "#fff";
      // 6 chips: the captured ones (team color, set by CSS) then the rest empty.
      let chips = "";
      for (let i = 0; i < perSuit[suit]; i++) chips += `<span class="tens-chip captured" title="${team === "A" ? "Team A" : "Team B"}"></span>`;
      for (let i = perSuit[suit]; i < COPIES_PER_SUIT; i++) chips += '<span class="tens-chip empty"></span>';
      html += `<div class="tens-row"><span class="tens-suit-label" style="color:${color}">${SUIT_GLYPH[suit]}</span><span class="tens-chips">${chips}</span></div>`;
    }
    wrap.innerHTML = html;
  }
  renderTeam("A", $("tens-tracker-a"));
  renderTeam("B", $("tens-tracker-b"));
}

function updateMyTurn() {
  state.myTurn = state.activeSeat === state.you;
  renderHand();
  // A new player's turn started: reset the local countdown to full and clear
  // any 5s warning. This re-syncs the decorative client timer to the server.
  if (state.activeSeat >= 0) {
    state.turnTime = TURN_SECONDS;
    state.turnWarningSeat = null;
    startTurnCountdown();
    renderSeats();
  }
}

// --- decorative turn-timer countdown (mirrors the server's authoritative timer) ---
let _turnCountdownHandle = null;
function startTurnCountdown() {
  stopTurnCountdown();
  _turnCountdownHandle = setInterval(() => {
    if (state.activeSeat < 0) return;
    state.turnTime = Math.max(0, state.turnTime - 1);
    renderTimerRing();
  }, 1000);
}
function stopTurnCountdown() {
  if (_turnCountdownHandle) { clearInterval(_turnCountdownHandle); _turnCountdownHandle = null; }
}

function isPlayable(card) {
  if (state.leadSuit) {
    const holdsLead = state.hand.some((c) => c.suit === state.leadSuit);
    if (holdsLead && card.suit !== state.leadSuit) return false;
  }
  return true;
}

function playCard(cardId) {
  send({ t: "play", cardId });
  state.myTurn = false;
  renderHand();
}

function nextSeat(seat) { return (seat + 1) % 10; }

function showMsg(text) {
  const bar = $("msg-bar");
  bar.textContent = text;
  bar.classList.remove("hidden");
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => bar.classList.add("hidden"), 2600);
}

// Lead-selection ceremony banner (center of table). Persistent (no auto-hide)
// since it narrates the whole ceremony; cleared on real deal.
function showLeadBanner(text) {
  const b = $("lead-banner");
  if (!b) return;
  b.textContent = text;
  b.classList.remove("hidden");
}
function hideLeadBanner() {
  const b = $("lead-banner");
  if (b) b.classList.add("hidden");
}

// ---------- UI wiring ----------
function getName() { return ($("name-input").value.trim() || "Player"); }

$("quick-btn").addEventListener("click", () => connect(getName(), { mode: "quick" }));
$("create-btn").addEventListener("click", () => connect(getName(), { mode: "private" }));
$("join-code-btn").addEventListener("click", () => {
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length < 4) return;
  connect(getName(), { mode: "private", roomId: code });
});
$("name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect(getName(), { mode: "quick" });
});
$("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-code-btn").click();
});
$("lobby-start-btn").addEventListener("click", () => send({ t: "startGame" }));
$("lobby-leave-btn").addEventListener("click", () => {
  disconnectVoice();
  stopTurnCountdown();
  resetMatchState();
  if (state.ws) state.ws.close();
  state.room = null; state.you = null;
  showScreen("join-screen");
});
// In-match "Leave" button — same teardown as lobby leave.
$("game-leave-btn").addEventListener("click", () => {
  disconnectVoice();
  stopTurnCountdown();
  resetMatchState();
  if (state.ws) state.ws.close();
  state.room = null; state.you = null;
  showChatPanel(false);
  showScreen("join-screen");
});
$("rematch-btn").addEventListener("click", () => {
  disconnectVoice();
  stopTurnCountdown();
  resetMatchState();
  if (state.ws) state.ws.close();
  state.you = null; state.room = null;
  showChatPanel(false);
  showScreen("join-screen");
});
// Voice mic toggle (match-only; button is hidden until voice connects).
$("voice-toggle").addEventListener("click", onVoiceButtonClick);
// Right-click (or long-press on mobile via contextmenu) leaves voice entirely.
$("voice-toggle").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.voiceConnected) leaveVoice();
});
// Lobby voice button shares the same behavior as the in-game one.
$("lobby-voice-toggle").addEventListener("click", onVoiceButtonClick);
$("lobby-voice-toggle").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.voiceConnected) leaveVoice();
});

// --- Tutorial / How to Play (window.Tutorial is defined by tutorial.js) ---
$("howto-btn").addEventListener("click", () => window.Tutorial && window.Tutorial.open("learn"));
$("game-help-btn").addEventListener("click", () => window.Tutorial && window.Tutorial.open("rules"));
$("end-help-btn").addEventListener("click", () => window.Tutorial && window.Tutorial.open("rules"));

// --- Auth screen wiring (Phase 1) ---
$("login-btn").addEventListener("click", () => { setAuthMode("login"); showScreen("auth-screen"); $("auth-email").focus(); });
$("signup-btn").addEventListener("click", () => { setAuthMode("signup"); showScreen("auth-screen"); $("auth-email").focus(); });
$("auth-guest-btn").addEventListener("click", () => showScreen("join-screen"));
$("auth-submit-btn").addEventListener("click", () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const name = $("auth-name").value.trim();
  const mode = ($("auth-submit-btn").textContent || "").includes("Create") ? "signup" : "login";
  if (!email || !password) { showAuthMsg("Enter your email and password."); return; }
  if (mode === "signup") {
    if (!name) { showAuthMsg("Choose a display name."); return; }
    doSignup(email, password, name);
  } else {
    doLogin(email, password);
  }
});
$("auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("auth-submit-btn").click(); });
$("auth-email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("auth-password").focus(); });

// Chat send wiring
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); sendChat(); }
});
// Mobile chat toggle
$("chat-toggle").addEventListener("click", () => {
  $("chat-panel").classList.toggle("hidden");
});

// ?room=ABCD deep-link: prefill the join code.
const params = new URLSearchParams(location.search);
if (params.get("room")) {
  $("code-input").value = params.get("room").toUpperCase();
}

// On load: if we have a stored token, silently validate it against the server
// so the menu shows the right logged-in state. Game play still works either way.
refreshAuthUI();
showScreen("join-screen");
$("name-input").focus();
if (state.token) {
  // Open a throwaway socket just to validate the token; connect() will reopen
  // when the user actually joins a game.
  openAuthSocketIfNeeded();
  if (state.ws.readyState === 1) send({ t: "authenticate", token: state.token });
  else state.ws.onopen = () => send({ t: "authenticate", token: state.token });
}

// Debug panel: only loaded if the server's debug gate passed (?debug=1 locally,
// ?debug=1&key=SECRET on live). hook() wires the trace; if debug.js never loaded,
// window.__dbg is undefined and this is a no-op. Normal players see nothing.
if (window.__dbg) window.__dbg.hook({ state, showScreen });
