// Mega Mendikot 5v5 — web client (no build step; vanilla JS)
"use strict";

const SUIT_GLYPH = { SPADES: "♠", HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣" };
const SUIT_COLOR = { SPADES: "black", HEARTS: "red", DIAMONDS: "red", CLUBS: "black" };
const RANK_NAME = { 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

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
  turnTime: 15,
  playedCards: [],
  winnerSeat: null,
  kittyActive: false,
  kittyLeft: 0,
  thinkingSeat: null,
  myTurn: false,
  myTeam: null,        // for team chat routing/display
  chatLog: [],         // ephemeral chat messages for the current match
  // --- LiveKit team voice (match-only, §6.1) ---
  voiceRoom: null,     // livekit.Room instance once connected
  voiceConnected: false,
  voiceMuted: false,
  voiceMutedSeats: {}, // seat -> bool (teammate mute indicators)
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

// ---------- connection ----------
// Opens the socket. If we have a stored token, we authenticate first and defer
// the `join` until the server confirms (so an authenticated user reclaims by
// their stable DB id). Guests send join immediately on open.
function connect(name, opts = {}) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.pendingMode = opts.mode || "quick";
  state.pendingRoomId = opts.roomId || null;
  state.pendingName = name;
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
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function handle(m) {
  switch (m.t) {
    case "hello": break;
    case "authOk": onAuthOk(m); break;
    case "authError": onAuthError(m); break;
    case "authDisabled": onAuthDisabled(m); break;
    case "loggedOut": onLoggedOut(); break;
    case "lobbyUpdate": onLobbyUpdate(m); break;
    case "init": onInit(m); break;
    case "trickStart": onTrickStart(m); break;
    case "played": onPlayed(m); break;
    case "trickWon": onTrickWon(m); break;
    case "botThinking": onBotThinking(m); break;
    case "trumpDeclared": state.trumpSuit = m.suit; renderHud(); break;
    case "matchEnd": onMatchEnd(m); break;
    case "chat": onChat(m); break;
    case "voiceState": onVoiceState(m); break;
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
  state.turnTime = m.turnTime;
  state.playedCards = m.playedCards || [];
  state.kittyActive = !!m.kittyActive;
  state.kittyLeft = m.kittyLeft;
  state.thinkingSeat = null;
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
  // Match-only voice: connect if the server minted a team-scoped token.
  connectVoice({ voiceUrl: m.voiceUrl, voiceRoom: m.voiceRoom, voiceToken: m.voiceToken });
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

// ---------- team voice (LiveKit) ----------
// The LiveKit browser SDK is loaded via CDN in index.html (the server stays
// zero-dependency). Voice is match-only: the server sends a voiceToken on init
// once the room is in PLAYING. A missing token, a failed mic permission, or an
// unreachable SFU must NEVER break the game — every path degrades to silent.
const LIVEKIT = typeof window !== "undefined" ? window.livekit : undefined;

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
    showMsg(`🎙️ Voice connected — talk to Team ${state.myTeam}`);
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

function updateVoiceButton() {
  const btn = $("voice-toggle");
  if (!btn) return;
  if (!state.voiceConnected) {
    btn.classList.add("hidden");
    btn.setAttribute("aria-pressed", "false");
    return;
  }
  btn.classList.remove("hidden");
  btn.textContent = state.voiceMuted ? "🔇 Muted" : "🎙️ Mic On";
  btn.setAttribute("aria-pressed", String(state.voiceMuted));
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
  const me = m.seats.find((s) => s.seat === state.you);
  const myTeamWon = me && me.team === m.winningTeam;
  $("end-title").textContent = myTeamWon ? "🎉 You Win!" : "💀 You Lost";
  $("end-title").style.color = myTeamWon ? "var(--gold)" : "var(--red)";
  $("end-score").textContent = `Team ${m.winningTeam} wins  ·  A ${m.score.A} – ${m.score.B} B`;
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
}

// ---------- rendering ----------
function showScreen(id) {
  ["join-screen", "auth-screen", "lobby-screen", "game-screen", "end-screen"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
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
    // Prefill the name field with the account name so guests don't have to type it.
    const nameInput = $("name-input");
    if (nameInput && !nameInput.value.trim()) nameInput.value = state.userName;
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
    // Voice indicator: only for teammates (opponent voice state is unknown and
    // irrelevant — they're in a different LiveKit room). "You" reflects your own
    // mic state; other teammates reflect the voiceState broadcasts we received.
    let voiceGlyph = "";
    const isTeammate = s.team === state.myTeam && !s.isBot;
    if (isTeammate && state.voiceConnected) {
      const muted = s.seat === state.you ? state.voiceMuted : !!state.voiceMutedSeats[s.seat];
      voiceGlyph = muted
        ? '<span class="voice-ind muted" title="Muted">🔇</span>'
        : '<span class="voice-ind on" title="Mic on">🎙️</span>';
    }
    el.innerHTML = `
      <div class="avatar">${initials}${voiceGlyph}</div>
      <div class="name">${s.seat === state.you ? "You" : s.name}</div>
      ${thinking ? '<div class="meta"><span class="thinking">thinking…</span></div>' : ''}`;
    table.appendChild(el);
  });
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
  sorted.forEach((card) => {
    const el = document.createElement("div");
    const playable = myTurn && isPlayable(card);
    el.className = "card" + (SUIT_COLOR[card.suit] === "red" ? " red" : "") + (myTurn ? (playable ? " playable" : " disabled") : " disabled");
    el.innerHTML = `<div class="rank">${RANK_NAME[card.rank]}</div><div class="suit">${SUIT_GLYPH[card.suit]}</div>`;
    if (playable) el.addEventListener("click", () => playCard(card.id));
    hand.appendChild(el);
  });
}

function renderHud() {
  $("score-a").textContent = state.score.A;
  $("score-b").textContent = state.score.B;
  $("trick-num").textContent = state.trickNumber;
  const td = $("trump-display");
  if (state.trumpSuit) {
    td.textContent = SUIT_GLYPH[state.trumpSuit];
    td.style.color = SUIT_COLOR[state.trumpSuit] === "red" ? "var(--red)" : "#fff";
  } else {
    td.textContent = "—";
    td.style.color = "var(--muted)";
  }
  const leadInfo = $("lead-info");
  const leadDisp = $("lead-display");
  if (state.leadSuit && leadInfo && leadDisp) {
    leadInfo.classList.remove("hidden");
    leadDisp.textContent = SUIT_GLYPH[state.leadSuit];
    leadDisp.style.color = SUIT_COLOR[state.leadSuit] === "red" ? "var(--red)" : "#fff";
  } else if (leadInfo) {
    leadInfo.classList.add("hidden");
  }
  renderSeats();
}

function updateMyTurn() {
  state.myTurn = state.activeSeat === state.you;
  renderHand();
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
  if (state.ws) state.ws.close();
  state.room = null; state.you = null;
  showScreen("join-screen");
});
$("rematch-btn").addEventListener("click", () => {
  disconnectVoice();
  if (state.ws) state.ws.close();
  state.you = null; state.room = null;
  showChatPanel(false);
  showScreen("join-screen");
});
// Voice mic toggle (match-only; button is hidden until voice connects).
$("voice-toggle").addEventListener("click", toggleVoiceMute);

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
