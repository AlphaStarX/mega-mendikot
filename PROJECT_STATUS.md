# Project Status — Mega Mindikot 5v5

> **Last updated:** 2026-06-22
> **Branch:** `staging` (production mirror: `live`, both on `github.com/AlphaStarX/mega-mindikot`)
> **Domain:** `mindikot.com` (registered at Porkbun) — `play.mindikot.com` (game),
> `voice.mindikot.com` (LiveKit SFU), `mindikot.com` (apex, redirects to play.*)
> **Host:** OVHcloud VPS-1 2027 (`vps-38d48eec.vps.ovh.ca`), Canada — Beauharnois (BHS),
> Debian 13, 2 vCores / 4 GB / 40 GB NVMe — **DEPLOYED & LIVE at https://play.mindikot.com**
> **Tests:** 50+ passing (rules + auth + livekit + bot + match + debug); match suite now <100ms
> (was ~20s+) via setImmediate-based fastTimers + waitFor polling.

> ⚠️ **AGENT GROUND RULES — read before doing anything**
> - **Never `git push` without explicit user permission.** Committing locally is fine,
>   but pushing to `origin` (any branch) requires the user to say so each time. Ask first.
> - Applies to `live` and `main` doubly — those are production. Never force-push, never
>   rewrite shared history, never push to either without a clear go-ahead.

This document tracks what's been built, what's deployed, and what's next. Keep it
updated as features ship.

---

## 1. What the project is

A real-time, team-based trick-taking card game for 10 players (5v5), inspired by the
traditional Indian card game *Mendikot*. Signature mechanics: a 192-card "mega deck"
(6 modified standard decks, ranks 7–A), a dynamically-established trump suit, the
"last identical highest card wins" duplicate rule, and an immediate-win objective
(first team to capture 13 of 24 Tens).

The implementation is a deliberately lightweight, **near-zero-dependency** single-process
Node app (hand-rolled WebSocket server per RFC 6455 over `node:http`). Deployed as one
containerized box: app + Postgres + LiveKit SFU + Caddy reverse proxy.

---

## 2. Feature inventory — what's built

### ✅ Core game (shipped, in `main`/`live`)
- **Authoritative rules engine** (`shared/rules.js`): 192-card deck, Fisher-Yates shuffle,
  10×18 deal + 12-card kitty, follow-suit validation, trick resolution with trump-over-lead
  + duplicate-rule tiebreak, ten counting, win-at-13 / 12-12 deadlock.
- **Bot AI** (`shared/bot.js`): full heuristic tree (lead L-1..4, follow F-1..3, trump
  declaration T-1..2, endgame secure/desperation). Unit-tested in `test/bot.test.js`
  (13 cases, one per heuristic + guards).
- **Match lifecycle** (`server/game-room.js`): LOBBY → LEAD_SELECT → DEALING → PLAYING → FINISHED,
  lead selection, 20s turn timer with auto-play, trump establishment, per-trick kitty reveal,
  reconnection + bot takeover.
- **Visible lead-selection ceremony**: before the real hand deals, one face-up card flips at each
  seat from a separate selection deck; tied seats redraw in shootout rounds until one player holds
  the unique highest card. The winner is highlighted, then play begins. Server-driven staged
  timers; client renders face-up cards + a narrating banner.
- **Deadlock UI + stale-state fix**: the HUD shows per-team tricks-won, and the end screen explains
  12-12 deadlock outcomes (decided by most tricks; a draw is possible at 9-9 tricks). A new
  `resetMatchState()` clears all per-match client state on every teardown so a fresh match never
  inherits stale table/hand/ceremony data — the cross-match race the debug panel was built to
  diagnose is now prevented at the source.
- **Multi-room matchmaking**: quick-match auto-fill (bots after 20s), private rooms with
  shareable 4-char codes, `?room=XXXX` deep-links, host concept.
- **Web client** (`client/`): vanilla HTML/CSS/JS, 10-seat perspective-rotated table,
  playable-card highlighting, kitty flip animation, team text chat, mobile-responsive.

### ✅ Voice chat — LiveKit (all-player, opt-in, lobby + match)
- **All-player audio**: one LiveKit room per match (`mm_{roomId}`) — all 10 players
  (both teams) share one room so everyone can hear everyone ("table talk" style).
  Previously team-scoped (`mm_{roomId}_{team}`); reopened to everyone by design.
- **Opt-in (off by default)**: voice does NOT auto-connect. The user must click the
  "🎙️+" (Join Voice) button, which sets `state.voiceWanted` (sticky across matches
  within a session) and triggers the browser's mic-permission prompt. Players who
  don't want voice are never prompted. Right-click the mic button leaves voice
  entirely (clears `voiceWanted`). See `offerVoice()` / `onVoiceButtonClick()`.
- **Lobby voice**: the server mints a per-seat voice token during LOBBY
  (`broadcastLobby()` sends `lobbyVoice` to each human), so players can talk
  *before* the match starts. A `#lobby-voice-toggle` button mirrors the in-game
  mic control. `voiceToggle` relay allows LOBBY (not just PLAYING).
- **Zero-dependency token minting** (`server/livekit.js`): hand-rolled HS256 LiveKit
  JWT via `node:crypto` (no `livekit-server-sdk`).
- **Self-hosted SFU**: documented in deploy runbook; runs as a Docker container.
  Vendored LiveKit browser SDK (`client/livekit-client.umd.min.js`, 364 KB) — no
  CDN dependency. The UMD global is `LivekitClient` (NOT `LiveKit`/`Livekit`;
  the old code looked for the wrong name → voice silently broken until fixed).

### ✅ Captured-10s chip tracker
- **Persistent on-screen display** of which 10s have been captured, by which team.
  A 4-row grid (one row per suit: ♠/♥/♦/♣) × 6 chips per row (6 copies of the 10
  per suit in the 192-card mega deck = 24 total Tens). Each chip is colored by the
  team that captured that copy (blue = Team A, red = Team B); empty/dashed = uncaptured.
- **Server is source of truth**: `this.capturedTens = { A: [{suit}], B: [{suit}] }`
  populated in `resolveTrick()` (both played cards and kitty reveal), sent in
  `init` (reconnect-safe) and `trickWon` (live). So a mid-match reconnect shows
  the correct history immediately.
- **Client** (`renderTensTracker()`): rebuilds the grid on every HUD render. Sits
  in a compact strip just below the score bar.

### ✅ Accounts — email/password (Phase 1)
- **Signup/login/logout** with persistent display name + cross-device reconnect.
- **Zero-dependency crypto** (`server/auth.js`): `scrypt` password hashing + HS256 JWT
  sessions, both via `node:crypto` (no `bcrypt`/`jsonwebtoken`).
- **Postgres + Prisma** (`server/db.js`, `prisma/schema.prisma`): the ONE intentional
  runtime dependency. Minimal `User` table (auth fields only; stats/XP are later phases).
- **Fail-soft**: if `DATABASE_URL`/`JWT_SECRET` unset, accounts are disabled and the game
  plays anonymously. Guests and authenticated players coexist.
- **Tested end-to-end locally** against a Docker Postgres — signup, login, reconnect,
  wrong-password rejection all verified.

### ✅ UI / UX polish
- **Turn-timer countdown ring**: circular SVG progress around the active player's avatar,
  counts down 20s (gold), flashes red at 5s. Client-run decorative countdown synced to
  the server's authoritative timer.
- **Casino "Monte Carlo" theme** (pure CSS, no deps): warm spotlight + damask-pattern
  background with vignette; richer felt table with mahogany rail + gold trim ring + faint
  center spade emblem; ornate panels (double border, art-deco corners, glow); gold-gradient
  shimmering title; polished buttons.
- **In-match control cluster**: Leave + "?" help are a matched glass-pill pair,
  pinned to the top-right corner and aligned vertically with the score panels
  (44px height, `top` offset matching the screen+HUD padding). Gold = info,
  red = destructive.
- **Chat panel**: resized to ~half height, centered on the right edge.
- **HUD header alignment**: Team A / center chips / Team B all share a `min-height:
  44px` so the header is one straight horizontal line (tops + bottoms aligned).
- **HUD center info**: Trump / Lead / Trick laid out horizontally as equal-width
  glass chips (one consistent set), enlarged to 15px/22px for readability; all
  three now use the `Label: value` format (e.g. `Trick: 1/18`); empty-trump state
  shows no dash placeholder; winning played card raised to `z-index: 5` so it
  always renders above overlaps.
- **"Thinking" indicator**: replaced the italic "thinking…" text with a chat-style
  three-gold-dot typing bubble.

### ✅ Interactive tutorial — "How to Play"
- **Learn + Rules hub** (`client/tutorial.js`): a self-contained module exposing
  `window.Tutorial { open, close, isLessonDone }`. Two tabs:
  - **Learn** — 6 hands-on lessons: count Tens, follow suit (legal vs illegal cards),
    dynamic trump (first off-suit sets it), winning a trick (step-through of the §9
    worked examples), the duplicate rule (last identical wins), and how to win (instant
    13-Tens + 12-12 deadlock). Interactive demos resolve live in the browser.
  - **Rules** — a searchable, sidebar-navigable reference distilled from `RULEBOOK.md`
    (Overview, Deck, Winning, Turns, Actions, Resolution, Special Rules, FAQ, Quick Start).
- **Vended rules copy**: the demos use a ~30-line local copy of
  `resolveTrickWinner` / `validatePlay` / `countTens` (flagged `// keep in sync with
  shared/rules.js`), mirroring the existing `computeWinningSeat` precedent in
  `client.js`. No build step, no module system, no new deps.
- **First overlay in the app**: a dimmed backdrop + `.card-panel`-styled shell at
  `z-index: 100`, toggled via `.hidden` independent of `showScreen`. Styled to match the
  Monte-Carlo theme; mobile-responsive.
- **Entry points**: "How to Play" on the menu (opens Learn), a `?` button in the game
  header + end screen (opens Rules), so a confused player can look up a rule mid-match
  without leaving the game.
- **Verified**: the vended resolver produces the correct winner for every RULEBOOK §9
  example (trump-beats-higher-lead, discard-can't-win, highest-trump, duplicate-last-wins)
  and the lesson scenarios.
- **Bug fixed**: wrapped `tutorial.js` in an IIFE — it had declared `const $` at the top
  level, colliding with `client.js`'s global `const $` and aborting all of `client.js`
  with a `SyntaxError`. Only `window.Tutorial` now escapes the IIFE.

### ✅ Debug panel (dev/QA tooling)
- **Purpose**: a client-side trace panel that captures every WebSocket message (in/out),
  every UI click, every screen transition, and game-state diffs — so bugs like the
  stale-state ceremony/game overlap can be diagnosed from a copy-pasted trace instead
  of guesswork.
- **Files**: `client/debug.js` (~200 lines, self-contained IIFE) + pure helpers in
  `client/debug-helpers.js` + ~40 lines of CSS + a guarded 2-line hook in `client.js`
  (`if (window.__dbg) ...` at the `handle`/`send` chokepoints). No new deps.
- **Tested** (35 new tests, zero new deps):
  - `test/debug-gate.test.js` — the full gate truth table (opt-in, loopback, key match,
    IPv4-mapped IPv6, the loopback-wins short-circuit).
  - `test/debug-http.test.js` — spawns the real server and asserts the script injection
    end-to-end (`?debug=1` injects, no-param doesn't, only `index.html` gets it, path
    traversal rejected). Also asserts **load order**: `debug.js` before `client.js`
    (regression guard for bug #2 above) and `debug-helpers.js` before `debug.js`.
  - `test/debug-helpers.test.js` — the pure `summarize` / `buildSnapshot` / `diffState`
    logic in Node (no DOM lib).
  - `docs/debug-qa-checklist.md` — manual checklist for the interactive panel features
    (filters, search, pause, copy, clear, collapse) that can't be auto-tested without
    a DOM library.
- **Refactor for testability** (behaviour unchanged): `debugAllowed` + `DEBUG_KEY`
  extracted into `server/debug-gate.js` (importable, same pattern as `auth.js` /
  `livekit.js`); `summarize` / state-diff extracted into `client/debug-helpers.js`.
- **Bugs fixed during testing** (the panel was silently non-functional before):
  1. **Wrong injection path**: was emitting `<script src="/client/debug.js">`, but client
     files are served **flat** (`CLIENT_DIR = client/`, so the correct URL is `/debug.js`).
     The nested path 404'd — the panel's JS never loaded even when the gate passed.
  2. **Wrong load order**: `debug.js` was injected after `client.js`, so `client.js`'s
     `if (window.__dbg) hook(...)` ran while `window.__dbg` was still undefined → the panel
     never armed. Now the debug scripts inject **before** `<script src="/client.js">`
     (classic scripts run in document order). Caught by manual testing.
- **Activation — secret-key gate** (zero risk to players):
  - **Local dev**: `http://localhost:3000/?debug=1` — works from loopback, no key needed.
  - **Live**: set env var `DEBUG_KEY=<long-random-secret>` on the server, then
    `https://mindikot.com/?debug=1&key=<secret>`.
  - **Normal players never receive the debug code**: the server only injects the debug
    `<script>` tags into the HTML when the gate passes (`debugAllowed(req)`, now in
    `server/debug-gate.js`). A plain `/` request, or `?debug=1` with a wrong/missing key
    from a non-loopback address, gets zero debug code. Verified via curl + automated tests.
- **Panel features**: timestamped color-coded log (messages/clicks/state/screens),
  type filters, substring search, pause/resume, **📋 Copy log** (clipboard export to
  paste back to the developer), clear, collapse.
- **State diffs**: snapshots ~12 key state fields per message; emits a compact
  `STATE changed: hand(0→18), leadSelectActive(true→false)` line — this is what makes
  cross-match stale-state races obvious.

### ✅ Deployment infrastructure
- **`Dockerfile`**: containerizes the app; runs `npm ci` + `prisma generate` + `migrate deploy`.
- **`deploy/docker-compose.yml`**: 4 services — `app` + `db` (postgres:16) + `livekit` SFU +
  `caddy` reverse proxy, all on one box.
- **`deploy/Caddyfile`**: automatic Let's Encrypt TLS for `play.*`, `voice.*`,
  and the apex `mindikot.com` (which 301-redirects to `play.*` for one canonical URL).
- **`deploy/livekit.yaml`**: self-hosted SFU + embedded TURN config.
- **`deploy/README.md`**: full 10-phase runbook (domain/DNS → provision → firewall →
  secrets → TURN cert → bring up → verify → ops), provider: OVHcloud (Canada BHS).
- **`render.yaml`**: alternative Render Blueprint (updated for deps + DB + auth).

> **Hosting note (history):** OVHcloud → DigitalOcean Toronto → Contabo → **back to
> OVHcloud**. OVH was first set aside due to a slow first-boot/provisioning experience
> (now resolved — the box is delivered and active); DigitalOcean was dropped on
> account/billing constraints; Contabo was tried and dropped as too expensive for the
> spec. Final choice: **OVHcloud VPS-1 2027** (`vps-38d48eec.vps.ovh.ca`), Canada —
> Beauharnois (BHS), 2 vCores / 4 GB / 40 GB NVMe, Debian 13, automated backups on.
> Includes OVH's free Anti-DDoS. The Docker/Caddy/LiveKit stack is host-agnostic; only
> the provisioning runbook changed between hosts.

### ✅ Code hygiene
- Removed dead code (`determineFirstLead`), dead CSS (`#retry-btn`, `#turn-timer`).
- Fixed client `turnTime` default (15 → 20, matching server).
- Fixed a pre-existing brace bug in `connect()`'s `onopen` handler.

---

## 3. Architecture at a glance

```
OVHcloud VPS-1 (Canada BHS / Beauharnois, Debian 13, Docker Compose)
├── caddy   (80/443, auto-TLS)  ─► play.mindikot.com  ─► app:3000
│                                └─ voice.mindikot.com ─► livekit:7880 (WSS signaling)
├── app     (node server/index.js)  — game + WS + auth + LiveKit token authority
├── db      (postgres:16)           — accounts (User table)
└── livekit (SFU + TURN)            — 5349/tcp+udp, 50000-60000/udp (direct, not proxied)
```

**Identity model:** anonymous `sessionId` (sessionStorage) for guests; stable DB `userId`
for authenticated users (token in localStorage → cross-device reconnect). The server is
authoritative for seat/team assignment; clients can't spoof.

**Zero-dependency ethos:** the game server + auth crypto + LiveKit token signing are all
hand-rolled with `node:crypto`. Postgres/Prisma is the single intentional runtime dep.

---

## 4. Branch model

| Branch | Purpose | Status |
|---|---|---|
| `main` | Original baseline (initial commit only) | Untouched since first commit |
| `live` | **Production — deployed on OVH** | In sync with `staging` (all features shipped here) |
| `staging` | Active development | In sync with `live` |

**Promotion flow:** develop on `staging` → test (`npm test`) → merge `staging` → `live` → push → redeploy:
```bash
git checkout live && git merge --ff-only staging && git push origin live
# then on the server: cd ~/mega-mindikot && git pull && cd deploy && docker compose up -d --build app
```
**Server clone** uses `-b live`: `git clone -b live https://github.com/AlphaStarX/mega-mindikot.git`.

---

## 5. Configuration / environment

| Variable | Purpose | Required for |
|---|---|---|
| `PORT` (3000) | HTTP/WS port | always |
| `HOST` (0.0.0.0) | bind address | always |
| `FILL_TIMER_MS` (20000) | quick-match bot fill delay | always |
| `DATABASE_URL` | Postgres connection | accounts (fail-soft if unset) |
| `JWT_SECRET` | HS256 session signing | accounts (fail-soft if unset) |
| `LIVEKIT_API_KEY` / `_SECRET` / `_URL` | SFU token minting | voice (fail-soft if unset) |
| `DEBUG_KEY` | secret gate for the client debug panel | optional; live debug needs `?debug=1&key=` |

Generate secrets with `openssl rand -base64 32`. See `deploy/.env.example`.

---

## 6. Commit history (recent — staging = live)

```
d37ce00 feat: apex redirect, opt-in voice, lobby voice, player README, faster tests
97ff842 feat: all-player voice, relocate mic button, captured-10s chip tracker
b8a06d4 fix(voice): vendor LiveKit SDK + correct UMD global name (LivekitClient)
f60ee44 docs: switch deployment target from Contabo to OVHcloud (Canada BHS, Debian 13)
0debaff docs: update PROJECT_STATUS — ceremony commit history + deadlock/stale-state notes
ddd6f6c Add visible lead-selection ceremony + deadlock UI + stale-state fix
3b3e9d4 Test the debug/logging panel and fix two load-time bugs
a430fcd Change 12-12 deadlock rule: most tricks won (was: last trick)
```
(Full earlier history in `git log`; initial commit was `68eda4d`.)

---

## 7. Roadmap — what's next

### 🔜 Immediate — deferred from the last batch (Task 7)
These were scoped and planned but deferred to a focused session (largest/riskiest change —
touches the seat/team model and the room lifecycle):

- **Team selection (pick a seat)**: today teams are fixed by seat index (`seat % 2`,
  `teamForSeat()` in `shared/rules.js`, assigned in `makeSeats()`, never reassigned).
  Planned: a clickable 10-seat table map in the lobby; `chooseSeat(seatIdx)` server
  method that flips a free bot seat to human (rejects if team has 5 humans). Changes
  `addHuman`/`nextOpenSeat` signatures + a new `chooseSeat` message handler.
- **Stay-in-lobby after match end ("Play Again")**: today `endMatch()` sets FINISHED
  and the cleanup interval deletes the room in 10s; the client's `#rematch-btn` closes
  the socket and returns to the main menu. Planned: a `resetToLobby()` method (zeros
  score/hands/capturedTens/etc., sets LOBBY, keeps humans seated), a `playAgain` host
  message, and the client's `#rematch-btn` sends `playAgain` instead of closing the WS.
- **Party cohesion**: falls out of the above for free (same room code, same players,
  voice persists across matches). At match-end, drop the `voiceEnd` broadcast so voice
  carries into the post-match lobby.

### Account-system phases (DB foundation is in place)
Phase 1 (auth) is done; these are additive:

| Phase | Feature | Effort |
|---|---|---|
| **2** | Win/loss stats + match history + profile screen | Small-medium |
| **3** | Leaderboard (top N by wins/rating) | Small |
| **4** | Player IDs (shareable), avatars, country flags | Medium |
| **5** | XP system + player levels | Medium |
| **6** | Friends list (add by ID, invite to room) | Medium-large |
| **7** | Google/GitHub OAuth | Medium |

### Small standalone TODOs
- **RULEBOOK.md 15s → 20s timer correction**: the live game uses a 20s turn timer
  (`TURN_SECONDS`), but RULEBOOK.md still says 15s in §7.6/§8.4/§11.5/§10.11.
  README was written with the correct 20s; the RULEBOOK itself needs the fix.
- **Speaking-activity indicators (VAD)**: the per-seat mic glyphs were removed (clutter);
  if "who is talking" is wanted, it needs LiveKit speaking events — a separate feature.
- **Mobile/touch polish** for the lobby seat-map UI (ships with Task 7).

> ✅ **Bot unit tests** — shipped (`test/bot.test.js`, 13 cases).
> ✅ **Interactive tutorial** — shipped (see §2).
> ✅ **Captured-10s tracker** — shipped (see §2).
> ✅ **Opt-in / all-player / lobby voice** — shipped (see §2).

---

## 8. Known limitations / TODOs

- **DEPLOYED & LIVE** at `https://play.mindikot.com` since 2026-06-22. The full
  stack (app + Postgres + LiveKit SFU + Caddy) is running on the OVH VPS
  (`158.69.49.43`). Game, accounts, voice all functional. Apex `mindikot.com`
  redirects to `play.*`.
- **Apex cert issuance**: on the very first request to `https://mindikot.com`,
  Caddy takes ~10-20s to obtain the Let's Encrypt cert — the browser may show a
  transient "can't provide a secure connection" until it's issued. One-time.
- **Task 7 deferred** (team selection + party/lobby flow) — see §7. This is the
  next major work item.
- **OAuth, stats, XP, friends, leaderboard** — all deferred to roadmap phases.
- **`sessionId` uses `sessionStorage`** for guests (lost on tab close). Authenticated
  users use `localStorage` tokens so they persist — but guests don't get cross-device
  reconnect.
- **`staging` push to GitHub** hit a transient network timeout on the last batch;
  the identical commit is already on `live`, so no divergence risk. Retries on next push.

---

## 9. How to run locally

```bash
npm install                              # installs Prisma + pg (the only deps)
npm test                                 # 50+ tests; match suite is <100ms (setImmediate fastTimers)
npm start                                # guest-only mode (no DB)

# With accounts (needs Docker):
docker run -d --name mm-db -p 5432:5432 \
  -e POSTGRES_USER=mm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mendikot postgres:16-alpine
DATABASE_URL="postgresql://mm:test@localhost:5432/mendikot" npx prisma migrate deploy
DATABASE_URL="postgresql://mm:test@localhost:5432/mendikot" JWT_SECRET="any-secret" npm start
# → http://localhost:3000 (will show "Accounts: enabled")
```

See `deploy/README.md` for the full production deployment runbook (OVHcloud).

> **Note on `staging` vs `live`:** both branches are kept in sync. Develop on
> `staging`, then fast-forward merge to `live` and push. The server clones `-b live`.
