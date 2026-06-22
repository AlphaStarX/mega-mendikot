// Tests for the debug-panel gate (server/debug-gate.js).
//
// The gate is security-critical: it controls whether the client debug code is
// served to a given request. This file pins the full truth table — opt-in,
// loopback detection, the key match, and the IPv4-mapped IPv6 strip — so a
// regression that leaks debug code to normal players fails loudly.
//
// We test `debugAllowedWith(key, req)` directly (it takes an explicit key, so
// cases can flip between "local" and "live" without env-juggling) and also
// verify the runtime export `debugAllowed(req)` reads process.env.DEBUG_KEY at
// module load. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { debugAllowed, debugAllowedWith } from "../server/debug-gate.js";

// Build a fake IncomingMessage with the url + peer the gate reads. Only two
// fields are touched: req.url and req.socket.remoteAddress.
function req(url, remote = "127.0.0.1") {
  return { url, socket: { remoteAddress: remote } };
}

const KEY = "super-secret-debug-key-123";

// --- opt-in: ?debug=1 is required under all configurations ---

test("no ?debug param → never allowed, regardless of source/key", () => {
  assert.equal(debugAllowedWith(KEY, req("/", "127.0.0.1")), false);
  assert.equal(debugAllowedWith("", req("/", "127.0.0.1")), false);
  assert.equal(debugAllowedWith(KEY, req("/?debug=0", "127.0.0.1")), false);
  assert.equal(debugAllowedWith(KEY, req("/?key=" + KEY, "127.0.0.1")), false);
  assert.equal(debugAllowedWith(KEY, req("/", "203.0.113.5")), false);
});

test("?debug=2 (not exactly '1') is not an opt-in", () => {
  assert.equal(debugAllowedWith(KEY, req("/?debug=2", "127.0.0.1")), false);
  assert.equal(debugAllowedWith("", req("/?debug=2", "127.0.0.1")), false);
});

// --- local dev: DEBUG_KEY unset (key === '') ---

test("local dev: ?debug=1 from loopback → allowed", () => {
  assert.equal(debugAllowedWith("", req("/?debug=1", "127.0.0.1")), true);
  assert.equal(debugAllowedWith("", req("/?debug=1", "::1")), true);
});

test("local dev: ?debug=1 from a non-loopback remote → blocked", () => {
  assert.equal(debugAllowedWith("", req("/?debug=1", "203.0.113.5")), false);
  assert.equal(debugAllowedWith("", req("/?debug=1", "10.0.0.5")), false);
});

test("local dev: a correct ?key= is irrelevant — loopback is what matters", () => {
  // key unset means the key branch never runs; supplying ?key= changes nothing.
  assert.equal(debugAllowedWith("", req("/?debug=1&key=anything", "203.0.113.5")), false);
  assert.equal(debugAllowedWith("", req("/?debug=1&key=anything", "127.0.0.1")), true);
});

// --- live: DEBUG_KEY set ---

test("live: ?debug=1&key=<correct> from a remote → allowed", () => {
  assert.equal(debugAllowedWith(KEY, req("/?debug=1&key=" + KEY, "203.0.113.5")), true);
});

test("live: wrong key from a remote → blocked", () => {
  assert.equal(debugAllowedWith(KEY, req("/?debug=1&key=wrong", "203.0.113.5")), false);
});

test("live: missing key from a remote → blocked", () => {
  assert.equal(debugAllowedWith(KEY, req("/?debug=1", "203.0.113.5")), false);
});

test("live: loopback always wins, even with a wrong/missing key (the || isLoopback short-circuit)", () => {
  // This is the documented behaviour: on a live server, hitting it from the box
  // itself still works without the key. The wrong key only blocks REMOTE reqs.
  assert.equal(debugAllowedWith(KEY, req("/?debug=1&key=wrong", "127.0.0.1")), true);
  assert.equal(debugAllowedWith(KEY, req("/?debug=1", "127.0.0.1")), true);
  assert.equal(debugAllowedWith(KEY, req("/?debug=1", "::1")), true);
});

// --- IPv4-mapped IPv6 normalization ---

test("IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is treated as loopback", () => {
  // Node reports IPv4 peers as ::ffff:127.0.0.1 on dual-stack sockets. The gate
  // strips the prefix before the loopback check.
  assert.equal(debugAllowedWith("", req("/?debug=1", "::ffff:127.0.0.1")), true);
  assert.equal(debugAllowedWith(KEY, req("/?debug=1", "::ffff:127.0.0.1")), true);
});

test("IPv4-mapped non-loopback is NOT treated as loopback", () => {
  assert.equal(debugAllowedWith("", req("/?debug=1", "::ffff:203.0.113.5")), false);
  assert.equal(debugAllowedWith(KEY, req("/?debug=1", "::ffff:203.0.113.5")), false);
});

// --- edge cases ---

test("missing url or socket.remoteAddress does not throw and defaults safely", () => {
  // remoteAddress undefined → "" → not loopback → blocked unless key matches.
  assert.equal(debugAllowedWith(KEY, req("/?debug=1&key=" + KEY, undefined)), true);
  assert.equal(debugAllowedWith("", { url: "/?debug=1", socket: {} }), false);
  assert.equal(debugAllowedWith("", { socket: {} }), false);
});

test("localhost string remote counts as loopback", () => {
  // Defensive: some proxies/hosts set the textual "localhost".
  assert.equal(debugAllowedWith("", req("/?debug=1", "localhost")), true);
});

// --- runtime export reads process.env.DEBUG_KEY at module load ---

test("runtime debugAllowed() honours the DEBUG_KEY captured at import time", () => {
  // We imported the module at the top of this file. Whatever DEBUG_KEY was then
  // (unset in the normal test environment) is what the runtime function sees.
  // We can't flip the env and see a change without re-importing, so we assert
  // the documented local-dev behaviour: loopback allowed, remote blocked.
  assert.equal(debugAllowed(req("/?debug=1", "127.0.0.1")), true);
  assert.equal(debugAllowed(req("/?debug=1", "203.0.113.5")), false);
  assert.equal(debugAllowed(req("/", "127.0.0.1")), false);
});
