# ♠ Mega Mendikot 5v5 ♥

A fully playable, self-contained build of **Mega Mendikot 5v5** — a 5v5 team
trick-taking card game — implementing the [master spec v1.3.0](./mega_mendikot_5v5_master_spec_v1_3.md).
One Node process serves the web client and runs the authoritative game server.
**Zero external dependencies** (Node 18+ only).

```
npm install      # no-op (no deps) — just verifies Node
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

**Future: adding auth, database, and chat**

This deployment is designed to grow:
- **Postgres:** Render → Add Database → copy `DATABASE_URL` into env vars. Add `pg` to dependencies, read `process.env.DATABASE_URL`.
- **Auth:** Add session/login middleware. The WebSocket already identifies clients by `sessionId` — swap it for an auth token.
- **Chat:** Add a `chat` message type. The room's `broadcast()` already reaches all players.

No restructuring needed — all three layer onto the existing single-server app.
