// Mega Mindikot 5v5 — client-side debug panel.
//
// Loaded ONLY when the server's debug gate passes (?debug=1 locally, or
// ?debug=1&key=SECRET on live). Normal players never receive this file's
// <script> tag, so it never executes for them.
//
// Captures a full trace: every WebSocket message (in/out), every UI click, every
// screen transition, and game-state diffs — shown in a floating panel you can
// filter, search, pause, and copy to clipboard for pasting back to the developer.
//
// Exposes window.__dbg.hook(handle, send, state, { showScreen }) which client.js
// calls once at startup. If debug.js never loaded, window.__dbg is undefined and
// client.js's guarded call is a no-op.
(function () {
  "use strict";

  // Defensive: even if somehow loaded without ?debug=1, do nothing.
  const params = new URLSearchParams(location.search);
  if (params.get("debug") !== "1") return;

  const MAX = 500;                  // ring-buffer cap
  const buf = [];                   // {kind, dir, text, time, detail}
  let paused = false;
  let filter = "all";               // all | msg | click | state | screen
  let search = "";
  let prevState = null;             // last state snapshot (for diffing)

  // --- the hooks the client wires in ---
  let _handle, _send, _state;

  function ts() {
    const d = new Date();
    return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  // Pure helpers (summarize + state snapshot/diff) live in debug-helpers.js,
  // loaded just before this file. They're DOM-free and unit-tested in Node.
  // Fall back to the inline copies only if the helper script somehow didn't load.
  const H = (typeof window !== "undefined" && window.DebugHelpers) || {};
  const summarize = H.summarize || function summarize(obj) {
    if (obj == null) return "";
    if (typeof obj !== "object") return String(obj);
    const t = obj.t || obj.type || "";
    const parts = [];
    for (const k of Object.keys(obj)) {
      if (k === "t" || k === "type" || k === "_ts") continue;
      let v = obj[k];
      if (Array.isArray(v)) v = `[${v.length}]`;
      else if (v && typeof v === "object") v = "{…}";
      else if (typeof v === "string" && v.length > 30) v = v.slice(0, 27) + "…";
      parts.push(`${k}:${v}`);
    }
    return `${t} {${parts.join(", ")}}`;
  };
  const buildSnapshot = H.buildSnapshot;
  const diffState = H.diffState;

  function push(kind, dir, text, detail) {
    if (paused) return;
    buf.push({ kind, dir, text, time: ts(), detail });
    if (buf.length > MAX) buf.shift();
    render();
  }

  // Snapshot the diffable subset of state; compare to prevState to emit a compact
  // "changed: a,b,c" line. This catches the stale-state races that break matches.
  // Pure computation is delegated to debug-helpers.js; this function owns the
  // side effect (push) and state retention (prevState).
  function snapshot(label) {
    if (!_state) return;
    const snap = buildSnapshot ? buildSnapshot(_state) : fallbackSnapshot(_state);
    if (prevState) {
      const line = diffState ? diffState(prevState, snap) : fallbackDiff(prevState, snap);
      if (line) push("state", "-", `STATE ${label || ""} ${line}`);
    }
    prevState = snap;
  }

  // Fallbacks only used if debug-helpers.js didn't load (defensive).
  function fallbackSnapshot(state) {
    return {
      matchState: state.leadSelectActive ? "LEAD_SELECT" : (state.hand && state.hand.length ? "PLAYING" : "IDLE"),
      hand: state.hand ? state.hand.length : 0,
      played: state.playedCards ? state.playedCards.length : 0,
      trickNumber: state.trickNumber,
      score: state.score ? `${state.score.A}-${state.score.B}` : "",
      tricks: state.tricksWon ? `${state.tricksWon.A}-${state.tricksWon.B}` : "",
      leadSuit: state.leadSuit || "",
      trumpSuit: state.trumpSuit || "",
      activeSeat: state.activeSeat,
      leadSelectActive: state.leadSelectActive,
      leadSelectWinner: state.leadSelectWinner,
      room: state.room || "",
      you: state.you,
    };
  }
  function fallbackDiff(prev, snap) {
    const changed = [];
    for (const k of Object.keys(snap)) {
      if (JSON.stringify(snap[k]) !== JSON.stringify(prev[k])) changed.push(`${k}(${prev[k]}→${snap[k]})`);
    }
    return changed.length ? `changed: ${changed.join(", ")}` : null;
  }

  // --- wiring ---
  // client.js calls window.__dbg.hook({ state, showScreen }) once at startup.
  // We expose _in(m) / _out(obj) which client.js invokes at its two chokepoints
  // (top of handle(), top of send()). This avoids touching 25 call sites.
  function hook(refs) {
    _state = refs.state;
    // Incoming message: log, snapshot before+after the handler runs. We can't wrap
    // handle() itself (it's a function decl called by reference), so client.js
    // calls _in() at the top of handle() and _post() isn't needed — we snapshot
    // in _in and diff on the NEXT _in/_out. Instead, snapshot-on-change by polling
    // key moments: simplest correct approach is to snapshot on every _in/_out.
    window.__dbg._in = (m) => {
      push("msg", "in", `← ${summarize(m)}`, m);
      snapshot("on-msg");
    };
    window.__dbg._out = (obj) => {
      push("msg", "out", `→ ${summarize(obj)}`, obj);
      snapshot("on-send");
    };
    // Screen transition hook: wrap the shared showScreen in place.
    if (refs.showScreen) {
      const orig = refs.showScreen;
      refs.showScreen = function (id) { push("screen", "-", `SCREEN → ${id}`); return orig(id); };
    }
    // One delegated click listener captures every button/card click (even dynamic ones).
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[id], button, .card") || e.target;
      const id = el.id || (el.className && el.className.split(" ")[0]) || el.tagName.toLowerCase();
      const label = (el.textContent || "").trim().slice(0, 20);
      push("click", "-", `CLICK #${id} "${label}"`);
    }, true);

    buildPanel();
    push("screen", "-", "DEBUG panel active");
  }

  // --- panel UI (built once, appended to <body>, outside #app) ---
  let listEl, filterEls;
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "dbg-panel";
    panel.innerHTML = `
      <div class="dbg-bar">
        <b class="dbg-title">🐛 Debug</b>
        <span class="dbg-spacer"></span>
        <button class="dbg-tab" data-f="all">All</button>
        <button class="dbg-tab" data-f="msg">Msg</button>
        <button class="dbg-tab" data-f="click">Click</button>
        <button class="dbg-tab" data-f="state">State</button>
        <input class="dbg-search" placeholder="filter…" />
        <button class="dbg-act" data-act="pause">⏸</button>
        <button class="dbg-act" data-act="copy">📋</button>
        <button class="dbg-act" data-act="clear">✕</button>
        <button class="dbg-act" data-act="hide">⋘</button>
      </div>
      <div class="dbg-list"></div>`;
    document.body.appendChild(panel);

    listEl = panel.querySelector(".dbg-list");
    filterEls = panel.querySelectorAll(".dbg-tab");
    const searchEl = panel.querySelector(".dbg-search");

    filterEls.forEach((b) => b.addEventListener("click", () => { filter = b.dataset.f; updateTabs(); render(); }));
    searchEl.addEventListener("input", () => { search = searchEl.value.trim().toLowerCase(); render(); });
    panel.querySelectorAll(".dbg-act").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.act;
      if (a === "pause") { paused = !paused; b.textContent = paused ? "▶" : "⏸"; }
      else if (a === "copy") copyLog();
      else if (a === "clear") { buf.length = 0; render(); }
      else if (a === "hide") { panel.classList.add("dbg-collapsed"); b.textContent = "⋙"; b.dataset.act = "show"; }
      else if (a === "show") { panel.classList.remove("dbg-collapsed"); b.textContent = "⋘"; b.dataset.act = "hide"; }
    }));
    updateTabs();
  }

  function updateTabs() {
    filterEls.forEach((b) => b.classList.toggle("active", b.dataset.f === filter));
  }

  function visible(e) {
    if (filter !== "all" && e.kind !== filter) return false;
    if (search && !e.text.toLowerCase().includes(search)) return false;
    return true;
  }

  function render() {
    if (!listEl) return;
    const rows = buf.filter(visible);
    listEl.innerHTML = rows.map((e) =>
      `<div class="dbg-row dbg-${e.kind}"><span class="dbg-time">${e.time}</span><span class="dbg-text">${escapeHtml(e.text)}</span></div>`
    ).join("");
    listEl.scrollTop = listEl.scrollHeight;
  }

  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  function copyLog() {
    const text = buf.map((e) => `${e.time} ${e.kind.toUpperCase()} ${e.text}`).join("\n");
    navigator.clipboard.writeText(text).then(
      () => push("screen", "-", "📋 Log copied to clipboard (" + buf.length + " entries)"),
      () => { /* clipboard blocked — fall back to console */ console.log("[debug log]\n" + text); }
    );
  }

  // Public API. client.js calls window.__dbg.hook(...) once at startup.
  window.__dbg = { hook };
  console.log("%c[debug] panel armed — add ?debug=1 to activate", "color:#f5c542");
})();
