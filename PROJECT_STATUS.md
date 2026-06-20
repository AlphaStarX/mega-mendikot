# Project Status — Mega Mindikot 5v5

> **Last updated:** 2026-06-20
> **Branch:** `staging` (production mirror: `live`, both on `github.com/AlphaStarX/mega-mindikot`)
> **Domain:** `mindikot.com` (registered at Porkbun; `play.mindikot.com` + `voice.mindikot.com`)
> **Target host:** DigitalOcean Droplet, Toronto (TOR1), Debian 12, 2 vCPU / 4 GB
> **Tests:** 47 passing (rules + auth + livekit + bot)

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
- **Match lifecycle** (`server/game-room.js`): LOBBY → DEALING → PLAYING → FINISHED, lead
  selection, 20s turn timer with auto-play, trump establishment, per-trick kitty reveal,
  reconnection + bot takeover.
- **Multi-room matchmaking**: quick-match auto-fill (bots after 20s), private rooms with
  shareable 4-char codes, `?room=XXXX` deep-links, host concept.
- **Web client** (`client/`): vanilla HTML/CSS/JS, 10-seat perspective-rotated table,
  playable-card highlighting, kitty flip animation, team text chat, mobile-responsive.

### ✅ Team voice chat — LiveKit (match-only)
- **Team-scoped audio**: one LiveKit room per team per game (`mm_{roomId}_{team}`). Opponents
  land in a different room → structural isolation, can't subscribe to your audio.
- **Zero-dependency token minting** (`server/livekit.js`): hand-rolled HS256 LiveKit JWT via
  `node:crypto` (no `livekit-server-sdk`). Matches the project's hand-rolled ethos.
- **Client** (`client/client.js`): connects on match start, tears down at match end; mic
  toggle; per-seat speaking/muted indicators. Fail-soft: if SFU unconfigured, silent.
- **Self-hosted SFU** (chosen): documented in deploy runbook; runs as a Docker container.

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

### ✅ Deployment infrastructure
- **`Dockerfile`**: containerizes the app; runs `npm ci` + `prisma generate` + `migrate deploy`.
- **`deploy/docker-compose.yml`**: 4 services — `app` + `db` (postgres:16) + `livekit` SFU +
  `caddy` reverse proxy, all on one box.
- **`deploy/Caddyfile`**: automatic Let's Encrypt TLS for `play.*` and `voice.*`.
- **`deploy/livekit.yaml`**: self-hosted SFU + embedded TURN config.
- **`deploy/README.md`**: full 10-phase runbook (domain/DNS → provision → firewall →
  secrets → TURN cert → bring up → verify → ops), provider: DigitalOcean Toronto.
- **`render.yaml`**: alternative Render Blueprint (updated for deps + DB + auth).

### ✅ Code hygiene
- Removed dead code (`determineFirstLead`), dead CSS (`#retry-btn`, `#turn-timer`).
- Fixed client `turnTime` default (15 → 20, matching server).
- Fixed a pre-existing brace bug in `connect()`'s `onopen` handler.

---

## 3. Architecture at a glance

```
DigitalOcean Droplet (Toronto, Debian 12, Docker Compose)
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
| `main` | Original baseline (initial commit only) | Untouched |
| `live` | Production mirror (= `main` currently) | Clean baseline |
| `staging` | Active development — **all features above** | 11 commits ahead of `main` |

**Promotion flow:** develop on `staging` → test → merge `staging` → `live` → deploy.
```bash
git checkout live && git merge --ff-only staging && git push origin live
```

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

Generate secrets with `openssl rand -base64 32`. See `deploy/.env.example`.

---

## 6. Commit history (staging)

```
68eda4d Initial commit: Mega Mendikot 5v5
992f1c8 Add team-scoped LiveKit voice chat (match-only)
4802d47 Add OVHcloud deployment stack (Docker + Caddy + LiveKit SFU)
5a043a2 Configure deployment for mindikot.com domain
7501ec8 Save full deployment guide to repo with Phase 0 (domain/DNS)
015ab78 Add account signup/login with Postgres + Prisma (Phase 1)
3808351 Add turn-timer countdown ring around active player's avatar
be8e34f Switch deployment docs from OVH to DigitalOcean (Toronto)
84bbe0d Casino 'Monte Carlo' theme + in-match Leave button + chat resize
cae2c14 Fix auth transition + duplicate-socket host bug; reset quick-match on leave
89ff16c Rename brand 'Mega Mendikot' -> 'Mega Mindikot' (domain: mindikot.com)
1a0f709 Add interactive tutorial + HUD/UI polish (chips, thinking dots, z-index)
f900cd6 Polish header alignment, chip sizing, Trick: label, control positioning
```

---

## 7. Roadmap — what's next (account system phases)

Phase 1 (auth) is done; the DB foundation is in place for these additive phases:

| Phase | Feature | Effort |
|---|---|---|
| **2** | Win/loss stats + match history + profile screen | Small-medium |
| **3** | Leaderboard (top N by wins/rating) | Small |
| **4** | Player IDs (shareable), avatars, country flags | Medium |
| **5** | XP system + player levels | Medium |
| **6** | Friends list (add by ID, invite to room) | Medium-large |
| **7** | Google/GitHub OAuth | Medium |

**Standalone ideas:** doc/version reconciliation
(README "15s"→20s timer, version drift), spectator mode, ranked seasons.

> ✅ **Bot unit tests** — shipped (`test/bot.test.js`, 13 cases). Was previously
> listed here; it's done.

> ✅ **Interactive tutorial** — shipped (see §2). Was previously listed here; it's done.

---

## 8. Known limitations / TODOs

- **Not yet deployed live.** The OVH plan was abandoned (poor service); DigitalOcean Toronto
  is the chosen host. Droplet not yet provisioned. All local testing passed.
- **LiveKit voice untested end-to-end** (requires a running SFU). Token minting + client
  wiring are complete and unit-tested; the manual cross-team audio test is pending deployment.
- **OAuth, stats, XP, friends, leaderboard** — all deferred to roadmap phases above.
- **Match tests are timing-fragile** — the headless all-bot test uses `realSleep(3000)` near
  the edge of completion time; occasionally flakes. Pre-existing, unrelated to new features.
- **`sessionId` uses `sessionStorage`** for guests (lost on tab close). Authenticated users
  use `localStorage` tokens so they persist — but guests don't get cross-device reconnect.

---

## 9. How to run locally

```bash
npm install                              # installs Prisma + pg (the only deps)
npm test                                 # 26 tests (rules + auth + livekit)
npm start                                # guest-only mode (no DB)

# With accounts (needs Docker):
docker run -d --name mm-db -p 5432:5432 \
  -e POSTGRES_USER=mm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mendikot postgres:16-alpine
DATABASE_URL="postgresql://mm:test@localhost:5432/mendikot" npx prisma migrate deploy
DATABASE_URL="postgresql://mm:test@localhost:5432/mendikot" JWT_SECRET="any-secret" npm start
# → http://localhost:3000 (will show "Accounts: enabled")
```

See `deploy/README.md` for the full production deployment runbook.
