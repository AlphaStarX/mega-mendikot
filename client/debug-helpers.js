// Mega Mindikot 5v5 — pure helpers for the client debug panel.
//
// Extracted from client/debug.js as a DOM-free module so the non-visual logic
// can be unit-tested under Node (see test/debug-helpers.test.js) without a
// jsdom/happy-dom dependency.
//
// This project has NO build step and NO module system on the client, so this
// file is a plain script: it attaches its API to globalThis (=== window in a
// browser). client/debug.js reads from window.DebugHelpers.
//
// In Node, importing this file ("../client/debug-helpers.js") runs the IIFE as
// a side effect and sets globalThis.DebugHelpers — tests then read it off
// globalThis. No `export` keyword (that would force ES-module loading and break
// plain <script> inclusion in the browser).
(function () {
  "use strict";

  // Summarize a message/click object compactly (avoid dumping 18-card hands etc.).
  function summarize(obj) {
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
  }

  // Build a compact, diffable snapshot of the state subset the panel tracks.
  function buildSnapshot(state) {
    if (!state) return null;
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

  // Compare a new snapshot to the previous one and produce a compact
  // `changed: a(old→new), b(old→new)` line. Returns null when nothing changed
  // (or when `prev` is null — the first snapshot is the baseline, never emitted).
  function diffState(prev, snap) {
    if (!prev) return null;
    const changed = [];
    for (const k of Object.keys(snap)) {
      if (JSON.stringify(snap[k]) !== JSON.stringify(prev[k])) {
        changed.push(`${k}(${prev[k]}→${snap[k]})`);
      }
    }
    if (!changed.length) return null;
    return `changed: ${changed.join(", ")}`;
  }

  const ns = { summarize, buildSnapshot, diffState };
  if (typeof window !== "undefined") window.DebugHelpers = ns;
  if (typeof globalThis !== "undefined") globalThis.DebugHelpers = ns;
})();
