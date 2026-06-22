// Tests for the pure client debug-panel helpers (client/debug-helpers.js).
//
// debug-helpers.js is a plain <script> IIFE with no `export` (the client has no
// module system), so importing it in Node runs the IIFE as a side effect and
// attaches DebugHelpers to globalThis. We then read it off globalThis.
//
// These cover the non-visual logic — summarize() compacting and the state-diff
// emission — without needing a DOM library. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../client/debug-helpers.js";

const { summarize, buildSnapshot, diffState } = globalThis.DebugHelpers;

// --- summarize() ---

test("summarize: null/undefined → empty string", () => {
  assert.equal(summarize(null), "");
  assert.equal(summarize(undefined), "");
});

test("summarize: a primitive is stringified", () => {
  assert.equal(summarize(42), "42");
  assert.equal(summarize("hello"), "hello");
  assert.equal(summarize(true), "true");
});

test("summarize: the 't' field is pulled out as the leading token", () => {
  assert.equal(summarize({ t: "play", card: "7H" }), "play {card:7H}");
  // 'type' is the fallback key name.
  assert.equal(summarize({ type: "click", x: 1 }), "click {x:1}");
});

test("summarize: arrays collapse to [length] (no hand dump)", () => {
  // 18-card hand → just the length, so the panel stays readable.
  assert.equal(summarize({ t: "deal", hand: ["7H", "8H", "9H"] }), "deal {hand:[3]}");
  assert.equal(summarize({ t: "x", empty: [] }), "x {empty:[0]}");
});

test("summarize: nested objects collapse to {…}", () => {
  assert.equal(summarize({ t: "score", team: { A: 6 } }), "score {team:{…}}");
});

test("summarize: long strings are truncated to 27 chars + …", () => {
  const long = "x".repeat(40);
  const out = summarize({ t: "msg", text: long });
  assert.ok(out.includes("text:" + "x".repeat(27) + "…"), `got: ${out}`);
  // And short strings are left alone.
  assert.equal(summarize({ t: "msg", text: "short" }), "msg {text:short}");
});

test("summarize: skips the t/type/_ts metadata keys", () => {
  assert.equal(summarize({ t: "a", _ts: 123, x: 1 }), "a {x:1}");
  assert.equal(summarize({ type: "a", _ts: 123, x: 1 }), "a {x:1}");
});

test("summarize: empty-ish object renders just the type token", () => {
  assert.equal(summarize({ t: "ping" }), "ping {}");
  assert.equal(summarize({ type: "ping" }), "ping {}");
  assert.equal(summarize({}), " {}"); // no t/type → empty leading token
});

// --- buildSnapshot() ---

test("buildSnapshot: null state → null", () => {
  assert.equal(buildSnapshot(null), null);
  assert.equal(buildSnapshot(undefined), null);
});

test("buildSnapshot: PLAYING state is detected from a non-empty hand", () => {
  const snap = buildSnapshot({ hand: ["7H"], score: { A: 1, B: 0 }, tricksWon: { A: 1, B: 0 } });
  assert.equal(snap.matchState, "PLAYING");
  assert.equal(snap.hand, 1);
  assert.equal(snap.score, "1-0");
  assert.equal(snap.tricks, "1-0");
});

test("buildSnapshot: LEAD_SELECT wins over hand presence", () => {
  const snap = buildSnapshot({ leadSelectActive: true, hand: ["7H"] });
  assert.equal(snap.matchState, "LEAD_SELECT");
});

test("buildSnapshot: empty hand + no lead-select → IDLE", () => {
  assert.equal(buildSnapshot({}).matchState, "IDLE");
  assert.equal(buildSnapshot({ hand: [] }).matchState, "IDLE");
});

test("buildSnapshot: missing optional fields degrade safely", () => {
  const snap = buildSnapshot({});
  assert.equal(snap.played, 0);
  assert.equal(snap.score, "");
  assert.equal(snap.tricks, "");
  assert.equal(snap.leadSuit, "");
  assert.equal(snap.activeSeat, undefined);
});

// --- diffState() ---

test("diffState: first snapshot (prev null) is the baseline → null (no line)", () => {
  assert.equal(diffState(null, { a: 1 }), null);
});

test("diffState: no changes → null", () => {
  const snap = { a: 1, b: "x" };
  assert.equal(diffState(snap, { a: 1, b: "x" }), null);
});

test("diffState: a changed field emits 'changed: field(old→new)'", () => {
  const prev = { hand: 0, score: "0-0" };
  const snap = { hand: 5, score: "0-0" };
  assert.equal(diffState(prev, snap), "changed: hand(0→5)");
});

test("diffState: multiple changes are comma-joined", () => {
  const prev = { hand: 0, score: "0-0", activeSeat: 0 };
  const snap = { hand: 5, score: "1-0", activeSeat: 1 };
  const out = diffState(prev, snap);
  assert.ok(out.includes("hand(0→5)"));
  assert.ok(out.includes("score(0-0→1-0)"));
  assert.ok(out.includes("activeSeat(0→1)"));
  assert.match(out, /^changed: /);
});

test("diffState: the full STATE line is assembled by the caller, not the helper", () => {
  // debug.js wraps diffState's output as `STATE <label> <line>`. The helper only
  // returns the 'changed: ...' part so it stays pure and testable.
  const line = diffState({ a: 1 }, { a: 2 });
  assert.equal(line, "changed: a(1→2)");
});
