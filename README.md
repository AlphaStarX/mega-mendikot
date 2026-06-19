# ♠ Mega Mendikot 5v5 ♥

A fully playable, self-contained build of **Mega Mendikot 5v5** — a 5v5 team
trick-taking card game — implementing the [master spec v1.3.0](./mega_mendikot_5v5_master_spec_v1_3.md).
One Node process serves the web client and runs the authoritative game server.

The game server is **hand-rolled** (custom WebSocket server per RFC 6455 over
`node:http`, no framework; auth crypto uses `node:crypto`'s scrypt + HS256, no
`bcrypt`/`jsonwebtoken`). The **one** external runtime dependency is Postgres
(via Prisma + pg) — used for accounts. If `DATABASE_URL`/`JWT_SECRET` are unset,
accounts are disabled and the game plays anonymously exactly as before.

```
npm install      # installs Prisma + pg (the only deps)
npm start        # → http://localhost:3000
```

Open the URL in a browser, enter a name, and play. You take seat 1 (Team A);
nine bots fill the remaining seats.

---

## How to play

- **Objective:** Be the first team to capture **13 of the 24 Tens** (the "Mendis").
- **Your turn:** Click a playable card in your hand. Gold-bordered cards are legal;
  dimmed cards violate the follow-suit rule.
- **Follow suit:** You must play the lead suit if you hold it. If you don't, you may
  play any card — the first off-suit play of the match **establishes trump permanently**.
- **Trump:** Once set, trump beats any lead-suit card. Trump appears in the HUD.
- **Duplicate rule:** With 6 copies of every card, ties go to the **last** identical
  highest card played.
- **Kitty:** Over the first 12 tricks, one hidden kitty card is revealed per trick and
  captured by the trick winner. A kitty Ten counts toward your team's score.
- **Turn timer:** 15s per play. Time out twice → marked AFK and auto-played.
- **Win:** First to 13 Tens wins instantly. A 12-12 tie after all 18 tricks goes to the
  team that won the final trick.

---

## Spec coverage (master spec v1.3.0)

| Spec section | Implementation |
|---|---|
| §2.1 Deck (192 cards, 6×32, ranks 7–14) | `shared/rules.js` `buildDeck` |
| §2.2/§2.10 Seating & team assignment (alternating A/B) | `server/game-room.js` `makeSeats` + `teamForSeat` |
| §2.3 12-card kitty, reveal over first 12 tricks | `resolveTrick` kitty block |
| §2.4 Lead selection (separate selection deck) | `start()` |
| §2.5 Follow-suit rule | `validatePlay` |
| §2.6 Dynamic trump (first off-suit sets it; lead can't declare) | `playCard` |
| §2.7 Trick resolution + "last identical wins" | `resolveTrickWinner` |
| §2.8 Win at 13 / 12-12 deadlock by last trick | `resolveTrick` + `endMatch` |
| §2.9 Turn timer (15s) + AFK (2 timeouts) | `tick` / `handleTimeout` |
| §3.4 Fog of war (opponent hands hidden) | only your hand is sent in `init` |
| §4 Bot heuristics (L-1..4, F-1..3, T-1..2) | `shared/bot.js` |
| §4.4 Reconnection + bot takeover | `onHumanDisconnect` / `onHumanReconnect` |

## Test

```
npm test         # 11 tests: rules unit + headless 10-bot full match
```

---

## Architecture

```
MegaMendiCoat/
├── package.json            # no runtime deps; Node 18+
├── shared/
│   ├── rules.js            # pure rules engine (deck, deal, resolve, win)
│   └── bot.js              # bot decision engine (spec §4)
├── server/
│   ├── index.js            # HTTP (static) + minimal WebSocket server (RFC 6455)
│   └── game-room.js        # authoritative match lifecycle
├── client/                 # static web client (no build step)
│   ├── index.html
│   ├── style.css
│   └── client.js
└── test/
    ├── rules.test.js       # unit tests
    └── match.test.js       # headless full-match tests
```

### Design notes

- **Authoritative server.** All rules, scoring, and validity run server-side. The
  client only renders state and forwards card clicks. The server rejects illegal plays
  (`error` messages) and double-plays.
- **Fog of war.** Only your own 18-card hand is ever sent over the wire; opponents are
  represented by card counts until they play.
- **Single shared room.** This build runs one match at a time (1 human + 9 bots). A new
  client either takes the human seat, reconnects to it (within 60s), or spectates. An
  abandoned room is recycled after the 60s grace window so a fresh match can start.
- **Bots fill every seat** so the game is instantly playable solo. They follow the full
  §4 heuristic tree, including trump declaration and the endgame desperation/secure modes.

### Deploy

The game is zero-dependency (Node 18+ only) and deploys to any host.

**Local / LAN:**
```
npm install      # no-op (no deps)
npm start        # listens on $PORT (default 3000), $HOST (default 0.0.0.0)
```

**Deploy to Render (free, public URL in 5 minutes):**

1. Push this repo to GitHub (`git push origin main`)
2. Go to [render.com](https://render.com) → sign in with GitHub
3. **New +** → **Web Service** → connect your GitHub repo
4. Render auto-detects Node from `package.json`. Confirm:
   - **Build Command:** leave blank (zero dependencies)
   - **Start Command:** `node server/index.js` (auto-detected)
5. Select **Free** plan → **Create Web Service**
6. Wait ~1 minute → your game is live at `https://your-app-name.onrender.com`

Or use the included **Blueprint** (`render.yaml`): New → Blueprint → connect repo → Render reads the config automatically.

**Share with friends:** give them the Render URL. Create a private room → share the link (`https://your-app.onrender.com/?room=ABCD`) or the 4-letter room code.

Render provides HTTPS + WebSocket support out of the box (the client auto-switches to `wss://` on HTTPS).

**Configuration (environment variables):**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WS port (set by Render automatically) |
| `HOST` | `0.0.0.0` | Bind address |
| `FILL_TIMER_MS` | `20000` | Quick-match: seconds before bots fill empty seats |
| `DATABASE_URL` | _(unset)_ | Postgres connection string. When unset, accounts are disabled and the game plays as guests. |
| `JWT_SECRET` | _(unset)_ | Account auth: HS256 signing secret for session tokens. |
| `LIVEKIT_API_KEY` | _(unset)_ | LiveKit voice (optional). When unset, voice is disabled and the game plays silently. |
| `LIVEKIT_API_SECRET` | _(unset)_ | LiveKit voice. Secret used to sign access tokens (HS256). |
| `LIVEKIT_URL` | _(unset)_ | LiveKit voice. SFU WebSocket URL clients connect to, e.g. `wss://livekit.your-host.com`. |

**Accounts (email/password)**

Accounts are **optional and fail soft**. If `DATABASE_URL` and `JWT_SECRET` are unset (the default), the signup/login UI is hidden and everyone plays as a guest — exactly as before. To enable:

1. Run Postgres (a `db` service is included in `deploy/docker-compose.yml`).
2. Set `DATABASE_URL` and `JWT_SECRET` on the server.
3. On first boot the app runs `prisma migrate deploy`, which creates the `User` table.

Players can then sign up / log in from the menu. Authenticated users keep their display name across sessions and reclaim their seat from any device (cross-device reconnect); the name can't be spoofed because the server reads it from the account. **Guests and logged-in players coexist** in the same rooms. Passwords are hashed with scrypt (`node:crypto`); sessions are HS256 JWTs — no `bcrypt`/`jsonwebtoken` deps.

**Voice (LiveKit team chat)**

Voice is **team-scoped and match-only**: teammates can hear each other during a match; opponents never can. The server derives each human's team from their seat (even seats = Team A, odd = Team B) and mints a LiveKit access token for a per-team room named `mm_{roomId}_{team}`. Because opponents land in a *different* room, audio isolation is structural — the client cannot spoof its team.

Voice is **optional and fails soft**. If the three `LIVEKIT_*` env vars are unset (the default), the server never mints tokens, the client never connects, and the game behaves exactly as before. To enable it:

1. **Self-host a LiveKit SFU** on a separate host (Render's free web tier can't run it). See the [LiveKit deploy guide](https://docs.livekit.io/deploy/vm/) and the [`livekit/livekit-server`](https://github.com/livekit/livekit-server) Docker image. Configure a **TURN** server — reliable NAT traversal needs it.
2. Set `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL` (the SFU's `wss://…` URL) on the Render web service.
3. That's it. The browser SDK loads via CDN (`livekit-client`, pinned in `client/index.html`) — **the server stays zero-dependency**. Tokens are signed JWTs minted with `node:crypto` in `server/livekit.js` (no SDK on the server).

Players will see a 🎙️ mic toggle during a match and a mic-state badge on each teammate's seat.

**Roadmap**

This deployment is designed to grow. Already shipped: **team chat**, **LiveKit voice**, and **accounts** (email/password + Postgres). Still ahead, each as an additive migration/phase:
- **OAuth** (Google/GitHub) — layered on the existing JWT account system.
- **Stats & match history** — new columns on `User`, written at match end.
- **Leaderboard, XP/levels, player IDs, avatars, friends** — all build on the DB foundation added here.

No restructuring needed — every phase layers onto the existing single-server app.
