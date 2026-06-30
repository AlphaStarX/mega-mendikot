# Project Status — Mega Mindikot 5v5

> **Last updated:** 2026-06-27 (hotfix batch on `staging`, pending `live` promote: stats-recording bug fix + live Online/Rooms presence counters)
> **Branch:** `staging` (production mirror: `live`, both on `github.com/AlphaStarX/mega-mindikot`)
> **⚠️ `staging` is ahead of `live`:** a hotfix batch (stats `$transaction` fix, live
> presence counters, played-card radius fix) is on `staging` and at
> `staging.mindikot.com` but **NOT yet promoted to `live`**. See §4 + §8.
> **Domain:** `mindikot.com` (registered at Porkbun) — `play.mindikot.com` (game),
> `voice.mindikot.com` (LiveKit SFU), `mindikot.com` (apex, redirects to play.*)
> **Host:** OVHcloud VPS-1 2027 (`vps-38d48eec.vps.ovh.ca`), Canada — Beauharnois (BHS),
> Debian 13, 2 vCores / 4 GB / 40 GB NVMe — **DEPLOYED & LIVE at https://play.mindikot.com**
> **Preview:** `https://staging.mindikot.com` — permanent always-on preview of the `staging` branch
> (own throwaway DB, shared SFU). Eyeball every change here before merging to `live`.
> **Auto-deploy:** push to `staging` → GitHub Actions runs tests → if green, rebuilds `staging-app`
> automatically (`.github/workflows/staging-deploy.yml`). Promotion to `live` stays manual.
> **Tests:** 130 passing (rules + auth + livekit + bot + match + debug + stats + leaderboard + identity); full suite ~1.1s (was a
> 5-min hang in CI — fixed via GameRoom timer teardown; see §2).
> **📖 Ops runbook:** `docs/DEPLOYMENT.md` — server details, day-to-day workflows,
> box-specific caveats, and troubleshooting. **Read it first in a new session.**

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

### ✅ Captured-10s chip tracker — per-team panels
- **Two trackers, one per team**: each team has its own 4×6 chip grid nested
  inside its score panel (A's under A's score, B's under B's), aligned to its
  own edge (A left, B right). Captured chips take the team color (blue/red via
  `.score.team-x .tens-chip.captured`); uncaptured are dashed outlines. Replaced
  the earlier single combined tracker — splitting it removed the "whose chip is
  whose" confusion.
- **Always rendered (alignment fix)**: both trackers show the full 4×6 grid at
  all times (even at match start, even when a team has 0 captures). Keeping both
  panels the same height keeps the score bar perfectly vertically aligned — an
  earlier "hide when empty" optimization caused the panels to go lopsided.
- **Server is source of truth**: `this.capturedTens = { A: [{suit}], B: [{suit}] }`
  populated in `resolveTrick()` (both played cards and kitty reveal), sent in
  `init` (reconnect-safe) and `trickWon` (live). So a mid-match reconnect shows
  the correct history immediately.
- **Client** (`renderTensTracker()` → inner `renderTeam(team, wrap)`): renders
  each team's own captures into its own panel; chips are `.captured` or `.empty`.

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

### ✅ Win/loss stats + Profile screen (Phase 2)
Authenticated players now accumulate lifetime aggregate stats, viewable on a
dedicated Profile screen. Builds directly on Phase 1's `User` table.

- **5 aggregate columns on `User`** (additive migration `20260623000000_add_player_stats`,
  all default 0): `wins`, `losses`, `draws`, `matchesPlayed`, `tensCaptured`. No
  per-match history table yet (a later phase). The app runs `migrate deploy` on
  container boot, so prod/staging apply it automatically on next rebuild.
- **`recordStats()` in `endMatch()`** (`server/game-room.js`): at match end, each
  authenticated human's row is incremented (matches +1; wins/losses/draws per
  their team's result; tensCaptured += their seat's tens). The identity seam is
  an `isAuthenticated` flag on the seat (set from `ws.userId` at join/seat-change)
  — an authenticated human's `User.id` flows through as `seat.sessionId`.
  **Fire-and-forget** (never `await`ed; the outer `.catch()` swallows errors into
  `this.log` so stats recording can't break the match-end flow).
  > **🐛 Bug found + fixed 2026-06-27 (on `staging`, pending `live`):** the original
  > `recordStats` chained `.catch()` onto each promise inside the Prisma
  > `$transaction([...])` array. Prisma requires **raw Prisma Client promises**
  > there — `.catch()` converts them to plain Promises, so the whole transaction
  > threw `All elements of the array need to be Prisma Client promises` *before
  > running any update*. The error was swallowed into `this.log` (never surfaced),
  > so **every match's stats + leaderboard write silently failed in production.**
  > Fix: removed the per-element `.catch()` (outer `.catch()` still guards); added
  > the `isAuthenticated` seat flag so guests are excluded from the transaction
  > (their random-hex sessionIds have no User row and would roll it back).
- **Pure classification** (`GameRoom.classifySeats(seats, winningTeam)` static):
  maps each **authenticated** human seat to `{won, lost, draw, tens}` — unit-tested
  in isolation with no DB. Handles the `winningTeam === null` (draw) and 12-12
  deadlock cases. (Filtered on `isAuthenticated` so guests never reach the DB.)
- **Stats ride auth responses**: `authOk` (login/signup/session-restore) now
  includes `stats: {wins,losses,draws,matchesPlayed,tensCaptured}`, so the client
  has data immediately on login without a round-trip. A `getStats` message
  returns fresh stats (e.g. to refresh the Profile screen after a match).
- **Dedicated Profile screen** (`#profile-screen`): a 3-card W/L/D grid (gold/red/
  muted), plus matches played, total Tens captured, and win-rate % (draws excluded
  from the denominator). Reached via a "📊 My Stats" button on the main menu
  (authenticated only; `refreshAuthUI` toggles it). Guests see a "log in to track
  stats" prompt with a login shortcut.
- **Tests:** +5 (classifySeats win/loss, draw, guest+bot skip, empty; recordStats
  fail-soft no-DB no-throw). **103/103 pass.**

### ✅ Leaderboard (Phase 3)
A public leaderboard screen showing the top players by total wins. Builds on
Phase 2's stats columns — no new data model, one read query + one screen.

- **Public access** — anyone can view, including guests (maximizes engagement;
  the query reads only `displayName` + stats, never emails/ids). A `getLeaderboard`
  message returns the top 50 (capped, on-demand — never on the hot match path).
- **Ranking by total wins** descending; ties broken by fewer matches played (a
  light skill tiebreak: reaching N wins in fewer games ranks higher). A
  min-matches floor (1) filters fresh 0-0-0 signups off the board.
- **`computeLeaderboardRows`** (`server/leaderboard.js`): pure function of raw
  User rows — sorts, assigns 1-based ranks, computes winRate (wins over decisive
  games, draws excluded, matching the profile screen). DB-free and unit-tested
  directly (10 cases).
- **Index-backed**: `@@index([wins])` added to the schema (migration
  `20260624000000_add_wins_index`) so the `ORDER BY wins DESC LIMIT 50` is
  index-backed as the player base grows.
- **Dedicated screen** (`#leaderboard-screen`): ranked rows (🥇🥈🥉 for top 3),
  W/L/D + win-rate per player, games played. Highlights the current user's row
  in gold + "(You)". Reached via "🏆 Leaderboard" on the main menu (always
  visible) and cross-linked from the profile screen ("View Leaderboard").
- **Tests:** +10 (`test/leaderboard.test.js`): sort, rank, tiebreak, winRate
  (incl. null on all-draws), floor filter, max cap, empty/defensive. **113/113 pass.**

### ✅ Player identity — player IDs, emoji avatars, country flags (Phase 4)
Three lightweight identity sub-features adding social/personal flair. No image
storage — avatar is an emoji code, country a 2-letter ISO code rendered as a flag
emoji client-side, player ID a short generated code. One additive migration.

- **Player IDs** — short shareable codes (`#A4F2K` style, 5 chars from an
  unambiguous alphabet), generated at signup (unique, immutable). Shown on the
  profile + copyable. Sets up Phase 6 (add friends by ID). Existing accounts get
  one via lazy backfill on next login.
- **Country flags** — a curated ~54-country dropdown (`shared/identity.js`) set on
  the Profile screen; renders as a flag emoji (regional-indicator algorithm)
  next to the player's name everywhere (lobby, game seats, leaderboard, profile).
  Empty = no flag.
- **Emoji avatars** — a curated ~46-emoji palette picker on the Profile screen.
  Shows in the avatar circle everywhere; unset falls back to the initials-in-a-
  circle behavior.
- **`shared/identity.js`** (source of truth, server+tests) + `client/identity-data.js`
  (flat-script mirror, since the client isn't ESM): the palette + country list +
  `flagEmoji()` + validators (`isValidCountry`/`isValidAvatar`).
- **Signup stays minimal** (name/email/password). Country + avatar are set via a
  Profile "Identity" → "Edit" flow (country `<select>` + emoji grid + Save). The
  `updateProfile` message validates input against the curated lists (rejects
  arbitrary emoji/codes) and replies `profileUpdated`.
- **Identity flows everywhere**: `authOk` carries `playerId`/`country`/`avatar`;
  the leaderboard query selects them; seats cache `avatar`/`country` at seat time
  (off the `ws` set during auth — no per-broadcast DB lookup) and carry them in
  the lobby/init/matchEnd/leadSelectEnter payloads.
- **Tests:** +17 (`test/identity.test.js`): flagEmoji (incl. lowercase/null/junk
  + code-point structure), country/avatar validation, generatePlayerId (length +
  alphabet + variety), data sanity (codes unique, every code has a flag).
  **130/130 pass.**

### ✅ Home-screen redesign — premium dashboard (LIVE)
The flat "name + two buttons" main menu was rebuilt as a premium,
casino-style dashboard that fills the screen, matched to an explicit
reference design. **Promoted to `live` 2026-06-26.** Pure HTML/CSS/JS-home
work; zero game-logic or server changes.

- **Full-width dashboard** (`.dash`, fills 100% width, no max-width cap) with a
  **top nav bar + 3-column body (nav | hero | stats) + footer**:
  - **Top nav bar** (`.dash-topbar`): brand on the left (♠ Mega Mindikot 5v5);
    auth on the right — "Signed in as **name**" + a red **Log out** button, or
    Log in / Sign up buttons for guests.
  - **Left nav rail** (`.dash-nav`): nav items (Home, Quick Match, Private Room,
    How to Play, My Stats, Leaderboard) that *dispatch* to the canonical hidden
    buttons (one delegated listener → `btn.click()`), so the visual nav and the
    real wiring stay decoupled. Bottom info chips: **Online Players** +
    **Active Rooms** (live — see presence below) + Community.
  - **Center hero** (`.dash-main`): a **framed glass hero panel** (`#hero-panel`)
    with a "Welcome Back" greeting (→ "Welcome back, **Name**!" when logged in),
    subtitle, the 3-card fan (A♠ · K♥ · Q♣), and a **5-stat row** with large
    icons (🃏 192 Cards · 👥 2 Teams · 🔟 24 Tens · 🏁 Race to 13 · ⚔️ 5v5 Mode).
    Below it: centered action buttons (`.dash-cta-stack`) and a room-code card.
  - **Right stats rail** (`.dash-stats`): "Your Stats" (2×2 tile grid — Games
    Played / Won / Win Rate / Tens) + "Top Players" (avatar/rank/name/score) +
    a "Create Room" promo card.
  - **Footer**: © 2026 Mega Mindikot 5v5 · Privacy · Terms · Contact.
- **Hero card fan**: three fanned face cards (A♠ · K♥ · Q♣) — proper playing-card
  markup (corner index + large centered pip), ivory gradient face, gold hairline,
  varnished gloss sheen, deep shadow, warm amber glow. Middle card front-most.
- **Inline room-code row**: `Room Code  [ROOM]  [Join]` — label + short input +
  a small compact Join button on one line (was a full-width stretched button).
- **Canonical IDs preserved**: `#quick-btn`, `#create-btn`, `#howto-btn`,
  `#profile-btn`, `#leaderboard-btn`, `#join-code-btn`, `#code-input`, `#name-input`,
  `#dash-greeting`, `#dash-mystats`, `#dash-topplayers`, `login-btn`, `signup-btn` —
  all existing wiring unchanged. A secondary `[data-action]` listener dispatches
  the Community chip + Create Room promo to the canonical buttons.
- **`renderDashStats()`** now renders a 2×2 stat-tile grid + top-player scores
  (avatar/rank/name/wins). **`renderGreeting()`** defaults to "Welcome Back".
- **Responsive** (`@media max-width: 880px`): the 3-column body collapses to a
  single stacked column; stat row reflows; footer wraps.
- **Tests:** 130/130 green (CSS/HTML/home-JS only — no suite touched).

### ✅ Game + lobby — 1080p scaling (LIVE)
The gameplay table and lobby screens were scaled to fill a 1920×1080 screen
the way the home screen now does. **Promoted to `live` 2026-06-26.** CSS-only —
safe because game seats position by **percentage** of the table (they scale
automatically; no JS/server changes).

- **Game HUD**: `max-width 1100px → 1480px` (spreads score panels across screen).
- **Game table**: `720×460 → 1180×620`, bounded so HUD + table + hand all fit.
- **`#table-wrap` `min-height:0` + `#hand-wrap` `min-height:168px`/`flex-shrink:0`**:
  the classic flexbox fixes — the table no longer crushes the hand off-screen,
  and stays a constant size across the lead ceremony (no hand) and play (hand),
  so there's **no table-size jump** between states.
- **Cards scaled proportionally**: hand `66×92 → 86×120`, played `52×74 → 66×94`,
  kitty `40×56 → 52×72`, lead-card `38×52 → 48×66`. Seat avatars `46→56px`,
  name plates `11→13px`, turn-timer ring `56→66px`.
- **Lobby**: panel `760 → 1040px` + `max-height:94vh`/`overflow-y:auto` (no more
  cut-off top/bottom); seat oval `64→66vh`; seats `12→14px`.
- **Mobile breakpoints untouched** (`@media max-width: 600px` / `480px`).

### ✅ Live presence counters — Online Players + Active Rooms (staging, pending live)
The home-screen info chips are now backed by real, live data (they were static
`—` placeholders when first added during the home redesign). **On `staging` —
not yet promoted to `live`.**

- **`getPresence`** (`server/index.js`): computes and replies
  `{ t: "presence", onlinePlayers, activeRooms }`.
  - **onlinePlayers** = `sockets.size` — **every connected WebSocket** (anyone with
    the page open: guest OR logged-in, home screen OR mid-match). The server keeps
    a `sockets` Set (add on connect, remove on close). *Earlier version only counted
    players seated in a room, so the count stayed flat on the home screen and
    dropped to 0 when a match ended — fixed.*
  - **activeRooms** = rooms with ≥1 human.
  - Cheap (in-memory), no DB. Public — guests can request it too.
- **Client** (`onPresence`): fills `#dash-online` / `#dash-rooms`. Requested on
  home-screen show (`refreshDash`) **and polled every 10s** while the home screen
  is visible, so the counters tick live as people join/leave the site.
- **Played-card spread** (bugfix, same batch): the played-card positioning radius
  is now scaled to the table's real width (was hardcoded 115px, which clustered
  cards at dead-center on the larger 1080p table → they read as invisible). This
  hotfix is already on `live`; the rest of the batch is pending.

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
  always renders above overlaps. **Lead chip stays always visible** — shows a
  muted `—` placeholder before the first card of a trick lands, then the suit
  glyph; no longer pops in/out between tricks (which shifted the center layout).
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

### ✅ Team selection + Play Again + party voice (Task 7)
The lobby is no longer a passive waiting list — players pick their seat, and a
finished match flows straight into a re-lobby instead of dumping everyone back
to the main menu. Three coupled changes:

- **10-seat clickable table map (lobby):** seats render around an oval (seat 0
  at top, clockwise), color-coded by team (even=A blue, odd=B red, matching
  `teamForSeat`). Open (bot) seats are dashed + clickable to claim; occupied
  seats show the name, 👑 host, and a gold ring on your own seat. Positions are
  trig-computed inline (no per-seat CSS classes). Mobile falls back to a 2-col
  grid so 10 chips don't overlap.
- **`chooseSeat` (server + client):** new LOBBY-only message lets a player move
  to any open bot seat. `GameRoom.chooseSeat()` reverts the old seat to a bot,
  moves the host crown if the host moves, and is naturally 5-per-team capped
  (only 5 seats exist per team). Replaces the old `nextOpenSeat` auto-balance as
  the seat-assignment path for players who want to choose.
- **Reliable lobby seat identity (`yourSeat`):** `broadcastLobby()` now sends
  each socket its own seat index first, so the client knows "you" without the
  old fragile name-match heuristic. The `findMySeat()` hack is gone.
- **Stay-in-lobby / Play Again (`resetToLobby` + `playAgain`):** a finished
  match no longer destroys the room. The host's "Play Again" calls
  `GameRoom.resetToLobby()` — zeros score/hands/captures/timers, resets per-seat
  match state, keeps humans seated, returns to `LOBBY`, and re-broadcasts the
  lobby so everyone flows back to the seat map together. Non-hosts see a
  "Waiting for host…" disabled button. Quick-match rooms re-arm the 20s fill
  timer; private rooms wait for the host's Start. The end screen gets a dedicated
  **Leave** button (previously the rematch button *was* the leave path).
- **Party voice (persists through match-end):** `endMatch()` no longer
  broadcasts `voiceEnd`, and the client no longer calls `disconnectVoice()` on
  match end — so the same `mm_{roomId}` LiveKit room carries audio from the
  match through the end screen and into the post-match lobby. Voice drops only
  when a player explicitly Leaves. The `voiceEnd` message + client case are
  removed entirely (dead code). `voiceToggle` relay now allows every non-dealing
  state (so mute works on the end screen too).
- **Host reassignment on disconnect:** if the host leaves at any time, the
  lowest-numbered connected human is promoted — previously the host was never
  reassigned, which stranded a room (directly relevant since Play Again is
  host-gated).
- **Cleanup reaper change:** a `FINISHED` room is now reaped only once no humans
  remain connected (was: reaped ~10s after finish regardless) — keeps the party
  together on the end screen. Empty-`LOBBY` behavior unchanged.
- **Tests:** 9 new (chooseSeat claim/occupied/outside-LOBBY/host-move/team-cap/
  yourSeat; host reassign; resetToLobby zeros + rejects). Existing `voiceEnd`
  assertion updated to the new "voice persists" contract. **98/98 pass.**

### ✅ Deployment infrastructure
- **`Dockerfile`**: containerizes the app; runs `npm ci` + `prisma generate` + `migrate deploy`.
- **`deploy/docker-compose.yml`**: 6 services in one shared stack — `app` + `staging-app`
  (both node :3000, reached by service name) + `db` + `staging-db` (postgres:16, separate
  volumes) + `livekit` SFU + `caddy` reverse proxy. Prod and staging share Caddy/network/SFU
  but are otherwise fully isolated.
- **`deploy/Caddyfile`**: automatic Let's Encrypt TLS for `play.*`, `staging.*`, `voice.*`,
  and the apex `mindikot.com` (which 301-redirects to `play.*` for one canonical URL).
- **`deploy/livekit.yaml`**: self-hosted SFU + embedded TURN config.
- **`deploy/README.md`**: full 10-phase runbook (domain/DNS → provision → firewall →
  secrets → TURN cert → bring up → verify → ops → staging), provider: OVHcloud (Canada BHS).
- **`docs/DEPLOYMENT.md`**: **the active ops runbook** — server details, the ship-to-staging /
  promote-to-prod workflows, box-specific caveats, the stash-pull-pop dance, troubleshooting,
  and the auto-deploy key setup. Read this first for day-to-day ops.
- **`render.yaml`**: alternative Render Blueprint (updated for deps + DB + auth).

### ✅ Staging environment — `staging.mindikot.com` (permanent preview)
- **Always-on preview of the `staging` branch**, isolated from prod. Same app image built from
  a second checkout (`~/mega-mindikot-staging`) with its **own throwaway Postgres** (`staging-db`
  / `pg_data_staging`), so signup/login/reconnect/migrations test against throwaway data. Voice
  reuses prod's shared LiveKit SFU (stateless tokens).
- **Brought up 2026-06-23**: DNS `staging` A record → cloned staging checkout → added
  `STAGING_DOMAIN` to `.env` → `docker compose up -d --build staging-app` → recreated Caddy
  (~5s prod blip) → Let's Encrypt cert issued for `staging.*` in ~3s. Total prod isolation:
  staging-app can't reach prod's `db`/`pg_data`; Caddy routes by hostname.
- **Cost:** ~+180 MB RAM (Node + Postgres) on the 4 GB box. Comfortable at launch scale.

### ✅ Auto-deploy to staging (GitHub Actions CI/CD)
- **`.github/workflows/staging-deploy.yml`**: on `push` to `staging`, runs the test suite; if
  green, SSHes into the box and rebuilds `staging-app`. `push → npm test → git pull +
  docker compose up --build staging-app → staging URL updated` within ~2 min. Two jobs
  (`test`, `deploy` with `needs: test`), `concurrency` cancels superseded runs, minimal
  `permissions: contents: read`. **Trigger is `staging`-only** — never `live`/`main`/PRs;
  promotion to prod stays a deliberate manual step.
- **Auth**: deploy-only ed25519 SSH key (public half in the box's `authorized_keys`, private
  half in GitHub secret `STAGING_SSH_KEY`). Additive — password login unaffected. Secrets:
  `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`. Setup in `docs/DEPLOYMENT.md §8a`.
- **A failing test blocks the deploy** (staging stays on last-good commit) — staging is always
  QA-able. First green run verified end-to-end 2026-06-23.

### ✅ Test-suite reliability fix (unblocked CI)
- **Root cause of the 5-min CI hang**: the match tests created `GameRoom`s and ran matches via
  `fastTimers()` (a global `setImmediate`-based timer override for speed) but **never tore the
  rooms down**. Each finished match left its turn-timer `setInterval`'s recursive `setImmediate`
  loop spinning forever, pinning the Node event loop so the process never exited. Every
  assertion passed — the suite just hung at exit. This blocked the auto-deploy test gate entirely.
- **Fix**: wrapped each match test in `try/finally` calling `room.clearTimers()` (the same
  teardown production's cleanup interval uses) before restoring timers. Full suite now runs in
  **~1.1s** (was a 5-min timeout): **89/89 pass, 0 fail**, clean exit.

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
OVHcloud VPS-1 (Canada BHS / Beauharnois, Debian 13, Docker Compose) — single stack
├── caddy        (80/443, auto-TLS) ─► play.mindikot.com    ─► app:3000         (prod)
│                                  ├─ staging.mindikot.com ─► staging-app:3000 (preview)
│                                  └─ voice.mindikot.com   ─► livekit:7880     (WSS signaling)
├── app          (node server/index.js)  — prod game + WS + auth + LiveKit tokens
├── staging-app  (node server/index.js)  — preview of staging branch
├── db           (postgres:16)           — prod accounts (User table)
├── staging-db   (postgres:16)           — throwaway staging accounts
└── livekit      (SFU + TURN, shared)    — 5349/tcp+udp, 50000-50100/udp (direct, not proxied)
```
See `docs/DEPLOYMENT.md` for the full ops runbook (workflows, caveats, troubleshooting).

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
| `live` | **Production — deployed on OVH** | Tip `b5712ff` (played-card radius hotfix, promoted 2026-06-26). **Behind `staging`** — the stats-recording fix + live presence counters are not yet promoted. |
| `staging` | Active development + **auto-deploys to staging URL** | **Ahead of `live`.** Tip `b3d65b7`: stats `$transaction` fix + presence counters. Eyeball `staging.mindikot.com`, then promote (see §4 promote flow). |

**Ship-to-staging flow (automated):** just push — CI does the rest:
```bash
git push origin staging
# → GitHub Actions: npm test → if green, SSH + rebuild staging-app
# → https://staging.mindikot.com updated within ~2 min
```

**Promote to prod flow (manual, by design):** QA on staging URL first, then:
```bash
git checkout live && git merge --ff-only staging && git push origin live
# then on the server: cd ~/mega-mindikot && git pull && cd deploy && docker compose up -d --build app
```
> Never automated — `live` is production and stays a deliberate human step.
> See `docs/DEPLOYMENT.md §2` for both flows + the manual-override SSH commands.

**Server checkouts:** prod at `~/mega-mindikot` (branch `live`), staging at
`~/mega-mindikot-staging` (branch `staging`). Both in one shared compose stack.

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

## 6. Commit history (recent)

> **Branch state:** `staging` is **ahead** of `live`. `staging` tip `b3d65b7` carries a
> hotfix batch: the stats-recording `$transaction` fix (`29eb56e`), live presence counters
> (`79815ec`), and the presence-count fix (`b3d65b7`). `live` tip `b5712ff` has only the
> played-card radius hotfix (promoted 2026-06-26). The pending batch needs eyeballing on
> `staging.mindikot.com` before the next promote.

```
b3d65b7 fix(home): online count now reflects ALL connected players           [staging]
79815ec feat(home): live Online Players + Active Rooms counters              [staging]
29eb56e fix(stats): recordStats $transaction threw on every match            [staging]
b5712ff hotfix(live): scale played-card radius to table size                 [staging+live]
968f58f feat(ui): scale game + lobby screens to fill 1080p                   [staging+live]
9beaa54 fix(ui): stat icon specificity + inline room code row                [staging+live]
e927f8b fix(ui): left-align + enlarge stat icons; compact the Join button    [staging+live]
4d5fb37 fix(ui): remove MM logo, add stat icons, center button text, logout  [staging+live]
84b1463 feat(ui): rebuild home as premium dashboard — topbar, body, footer   [staging+live]
8d2e4ac fix(ui): fill empty center column — cap dashboard width, widen...    [staging+live]
b534154 fix(ui): enlarge hero card fan to fill the center column             [staging+live]
3aa6710 feat(ui): rebuild home hero card stack as premium playing cards      [staging+live]
5959d70 feat(ui): rebuild home center to match reference design              [staging+live]
c14e284 ui: remove card-fan centerpiece from home screen center              [staging+live]
7bb39bf feat(ui): redesign home screen as a full-screen immersive hero        [staging+live]
04984da fix(ui): profile/leaderboard panels scroll instead of off-screen      [staging+live]
3f190ea feat(ui): redesign home screen as a 3-zone dashboard                  [staging+live]
d2c23ee feat(identity): Phase 4 — player IDs, emoji avatars, country flags    [staging+live]
da72974 docs: update PROJECT_STATUS — staging env, auto-deploy CI, trackers  [staging+live]
1682b31 feat(leaderboard): Phase 3 — public leaderboard by total wins        [staging+live]
8380f6a feat(lobby): team selection + Play Again + party voice (Task 7)      [staging+live]
```
(Full earlier history in `git log`; initial commit was `68eda4d`.)

---

## 7. Roadmap — what's next

### 🔜 Immediate — next up
Phases 1–4, Task 7, the home redesign, and the game/lobby 1080p scaling are all
shipped **and promoted to `live`** (2026-06-26). A **hotfix batch is on `staging`,
pending promote** (see §4): the stats-recording `$transaction` fix (production stats
+ leaderboard were silently broken), live Online/Rooms presence counters, and the
played-card spread fix (the card one is already on `live`). The next steps:

- **Promote the hotfix batch to `live`** — stats fix (`29eb56e`) + presence
  (`79815ec`/`b3d65b7`). Eyeball `staging.mindikot.com` first (verify stats update
  after a match + the Online/Rooms counters tick), then the standard
  `staging → live` merge + box rebuild. **Priority: prod stats/leaderboard are
  currently broken**, so this should go up soon.
- **Real-device QA pass** on the production build — sign up, play a full Quick Match
  against bots, try Create Room + the lobby seat map. The 1080p scaling was eyeballed
  locally but not yet stress-tested in real multi-player play.
- **Mobile/touch polish** for the lobby seat-map (the oval→grid fallback works, but
  tap targets + the claim interaction want a real-device pass) and the new home
  dashboard (the 3-column body collapses to a stacked column, but needs a real-device
  pass — especially the center hero on narrow phones).
- **Phase 5: XP system + player levels** — the next account-system phase (Medium).
  The DB foundation (User table + stats columns) is already in place.
- **Small standalone TODOs:** commit the 2 box-only deploy edits (staging build-
  context path, LiveKit UDP range `50000-50100`) to shrink the stash-pull-pop
  dance on prod pulls; pin the SSH deploy action to a SHA (supply-chain hardening).

### Account-system phases (DB foundation is in place)
Phases 1–4 are done; these are additive:

| Phase | Feature | Effort |
|---|---|---|
| **2** ✅ | ~~Win/loss stats + profile screen~~ — shipped (aggregates only; per-match history is a later phase) | — |
| **3** ✅ | ~~Leaderboard (top N by wins)~~ — shipped | — |
| **4** ✅ | ~~Player IDs, emoji avatars, country flags~~ — shipped (no image upload; emoji palette + ISO codes) | — |
| **5** | XP system + player levels | Medium |
| **6** | Friends list (add by ID, invite to room) — player IDs already in place | Medium-large |
| **7** | Google/GitHub OAuth | Medium |

### Small standalone TODOs
- **Repo ↔ box drift (cleanup from staging bring-up):** the box's `~/mega-mindikot`
  has 3 local edits not in the repo (see `docs/DEPLOYMENT.md §5`). Two should be
  committed to align repo with reality: (a) staging build-context path
  (`../../mega-mindikot-staging`, not `../mega-mindikot-staging`); (b) LiveKit UDP
  range `50000-50100` (not `50000-60000`, to match the box's UFW). The third
  (`livekit.yaml` real secrets) stays box-only by design. Fixing (a)+(b) shrinks
  the stash-pull-pop dance to just `livekit.yaml`.
- **Pin the SSH deploy action to a SHA** (currently `appleboy/ssh-action@v1.2.0`)
  for supply-chain hardening. Optional; the version pin is fine to start.
- **Speaking-activity indicators (VAD)**: the per-seat mic glyphs were removed (clutter);
  if "who is talking" is wanted, it needs LiveKit speaking events — a separate feature.
- **Per-match history**: Phase 2 records aggregate stats only (wins/losses/tens). A
  scrollable match-by-match history needs a new `Match` table — a later phase.

> ✅ **Bot unit tests** — shipped (`test/bot.test.js`, 13 cases).
> ✅ **Interactive tutorial** — shipped (see §2).
> ✅ **Captured-10s tracker (per-team panels)** — shipped (see §2).
> ✅ **Opt-in / all-player / lobby voice** — shipped (see §2).
> ✅ **Staging environment + auto-deploy CI** — shipped (see §2).
> ✅ **Task 7: team selection (10-seat table map) + Play Again + party voice** — shipped (see §2).
> ✅ **Phase 4: player IDs, emoji avatars, country flags** — shipped, live (see §2).
> ✅ **Home-screen redesign: premium dashboard (topbar + 3-col body + footer)** — shipped, live (see §2).
> ✅ **Game + lobby 1080p scaling** — shipped, live (see §2).
> 🔨 **Live presence counters (Online Players + Active Rooms)** — shipped on `staging`; pending `live` promote (see §2).
> 🔨 **Stats-recording fix (recordStats $transaction)** — shipped on `staging`; pending `live` promote. **Prod stats/leaderboard are currently broken until this promotes.**

---

## 8. Known limitations / TODOs

- **⚠️ Production stats/leaderboard are BROKEN on `live` (fix on `staging`, pending promote):**
  `recordStats()` threw on every match due to a Prisma `$transaction` contract
  violation (`.catch()` chained on each array element). So completing a match in
  production does NOT update personal stats or the leaderboard. **Fixed on `staging`
  (`29eb56e`)** — verify there, then promote to `live` ASAP.
- **DEPLOYED & LIVE** at `https://play.mindikot.com` since 2026-06-22. The full
  stack (app + Postgres + LiveKit SFU + Caddy) is running on the OVH VPS
  (`158.69.49.43`). Game, accounts, voice all functional. Apex `mindikot.com`
  redirects to `play.*`. **Staging preview** live at `https://staging.mindikot.com`
  since 2026-06-23 (own throwaway DB, shared SFU, auto-deploys on push).
- **`staging` is ahead of `live`:** a hotfix batch (stats `$transaction` fix, live
  Online/Rooms presence counters, presence-count fix) is on `staging` and at
  `staging.mindikot.com`, but **not yet on production** (`play.*`). Only the
  played-card radius hotfix was promoted (2026-06-26). Needs a QA pass + manual
  promote (§4).
- **Apex cert issuance**: on the very first request to `https://mindikot.com`,
  Caddy takes ~10-20s to obtain the Let's Encrypt cert — the browser may show a
  transient "can't provide a secure connection" until it's issued. One-time.
- **Per-match history**: Phase 2 records aggregate stats only (wins/losses/tens).
  A scrollable match-by-match history needs a new `Match` table — a later phase.
- **OAuth, XP, friends** — all deferred to roadmap phases (Phases 5–7). Phase 4
  (identity) shipped; the rest are additive and not started.
- **`sessionId` uses `sessionStorage`** for guests (lost on tab close). Authenticated
  users use `localStorage` tokens so they persist — but guests don't get cross-device
  reconnect.
- **Box SSH is password-based** as `debian` (the README's Phase 2 `mm`-user hardening
  was never run). A deploy-only ed25519 key was added for GitHub Actions (additive);
  password login is still the human path. See `docs/DEPLOYMENT.md §1, §8a`.

---

## 9. How to run locally

```bash
npm install                              # installs Prisma + pg (the only deps)
npm test                                 # 130 tests; full suite ~1.1s (match suite uses setImmediate fastTimers)
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
