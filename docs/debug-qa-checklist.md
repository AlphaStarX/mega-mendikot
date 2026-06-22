# Debug Panel — Manual QA Checklist

The client debug panel (`client/debug.js`) is a DOM-bound, interactive tool.
Its pure logic (gate, summarize, state-diff, script injection) is covered by
automated tests (`test/debug-gate.test.js`, `test/debug-helpers.test.js`,
`test/debug-http.test.js`). The interactive behaviour below can't be
auto-tested without a DOM library (jsdom/happy-dom), which the project's
zero-dependency ethos rules out — so it gets this manual checklist.

Use it after any change to `client/debug.js`, `client/debug-helpers.js`, or the
injection in `server/index.js`.

---

## Setup

1. Start the server locally: `npm start` → `http://localhost:3000`.
2. Open `http://localhost:3000/?debug=1` in a browser. (No key needed from
   loopback. On a live server use `?debug=1&key=<DEBUG_KEY>`.)
3. Open DevTools → Console. You should see:
   `[debug] panel armed — add ?debug=1 to activate`
4. The 🐛 **Debug** panel appears docked to the bottom-right.

## A. Activation & gating (negative cases)

- [ ] **`http://localhost:3000/` (no `?debug=1`)** → no panel, no `window.__dbg`
      in the console. (The script tag is never injected; verified by
      `debug-http.test.js`, but confirm in the browser too.)
- [ ] **`?debug=1` from a non-loopback host with `DEBUG_KEY` unset** → no panel.
      (Simulate by hitting the server from another machine, or trust the unit test.)
- [ ] **DevTools → Sources**: confirm `/debug.js` and `/debug-helpers.js` are
      loaded (not 404). If either 404s, the injection path in `server/index.js`
      regressed to the nested `/client/...` form — see the
      "debug-helpers.js file is served (flat URL)" test.

## B. Panel chrome

- [ ] Panel header reads **🐛 Debug**.
- [ ] Filter tabs present: **All / Msg / Click / State**. (Note: there is no
      dedicated **Screen** tab — `SCREEN →` events only show under **All**.)
- [ ] Controls present right-to-left: search box, ⏸ (pause), 📋 (copy), ✕ (clear), ⛘ (hide).
- [ ] An initial row appears: `DEBUG panel active` (purple, `screen` kind).

## C. Capturing — play a few actions and watch rows stream in

1. Click **Quick Match** (or join a room) and play through the lead-select + a trick or two.
2. Confirm each event type appears, color-coded:
   - [ ] **Blue** rows `← <type> {…}` — incoming WebSocket messages (server → client).
   - [ ] **Blue** rows `→ <type> {…}` — outgoing WebSocket messages (client → server).
   - [ ] **Amber** rows `CLICK #<id> "<label>"` — UI clicks on buttons/cards/`[id]` elements.
   - [ ] **Purple** rows `SCREEN → <id>` — screen transitions (join-screen, game-screen, end-screen…).
   - [ ] **Orange** rows `STATE <label> changed: field(old→new), …` — game-state diffs.
3. [ ] Confirm **hand arrays are NOT dumped** — a deal message shows `hand:[18]`,
       not the actual cards. (This is `summarize()`; unit-tested, but eyeball it.)

## D. Filter tabs

- [ ] Click **Msg** → only blue in/out message rows remain.
- [ ] Click **Click** → only amber click rows remain.
- [ ] Click **State** → only orange state-diff rows remain.
- [ ] Click **All** → everything visible again. The active tab is highlighted gold.
- [ ] **Screen** events (`SCREEN →`, `DEBUG panel active`) are only visible under
      **All** — confirm they disappear under Msg/Click/State.

## E. Search

- [ ] Type `play` in the search box → only rows containing "play" (case-insensitive)
      remain. Clear the box → all rows return.
- [ ] Search composes with the active filter (e.g. **Click** tab + `card`).

## F. Pause / resume

- [ ] Click ⏸ → icon becomes ▶. Perform some actions → **no new rows appear**.
- [ ] Click ▶ → icon becomes ⏸. Perform an action → the new row appears.
      (Paused entries are dropped, not queued — they do not backfill on resume.)

## G. Clear

- [ ] Click ✕ → the list empties immediately. (The buffer is reset, not just hidden.)

## H. Copy log

- [ ] Click 📋 → a row appears: `📋 Log copied to clipboard (N entries)`.
- [ ] Paste into a text editor → entries are `HH:MM:SS.mmm KIND text`, one per line.
- [ ] **Clipboard-blocked fallback**: if the browser blocks `navigator.clipboard`
      (e.g. insecure context, permission denied), the log is written to the
      **Console** instead as `[debug log]\n…`. Verify by disabling clipboard
      permission in site settings and re-clicking 📋.

## I. Collapse / show

- [ ] Click ⛘ → panel collapses to a thin bar (30px), icon becomes ⋙.
- [ ] Click ⋙ → panel expands back, icon becomes ⛘. Capturing continues while
      collapsed (rows still buffer; verify by expanding and seeing recent events).

## J. Buffer cap

- [ ] The ring buffer caps at **500 entries**. Hard to hit by hand quickly; if you
      do (long match), confirm the oldest rows are dropped, not the panel frozen.
      (Unit-covered indirectly via `summarize`; the cap itself is in `debug.js`.)

## K. Stale-state race (the original motivation)

The panel exists to catch the ceremony/game overlap bug. To exercise the diff:

- [ ] Finish a lead-select ceremony and enter a real hand. You should see a
      `STATE on-msg changed: … leadSelectActive(true→false), hand(0→18) …` style line.
- [ ] Start a new match after a finished one. Confirm `matchState` transitions
      cleanly (`FINISHED`-ish → `LEAD_SELECT` → `PLAYING`) with no leftover fields
      from the previous match stuck mid-diff.

---

## Automated coverage (for reference)

| Layer | Test file | What's covered |
|---|---|---|
| Gate truth table | `test/debug-gate.test.js` | opt-in, loopback, key match, IPv6-mapped, loopback-wins short-circuit |
| HTTP injection | `test/debug-http.test.js` | real server, `?debug=1` injects, no-param doesn't, flat URL, only index.html, path traversal |
| Pure client logic | `test/debug-helpers.test.js` | `summarize`, `buildSnapshot`, `diffState` |

Everything in **this checklist** is the DOM-interactive layer on top of those.
