// Mega Mindikot 5v5 — debug-panel gate (secret-key).
//
// Extracted from server/index.js as a pure, importable module so the gate can
// be unit-tested in isolation (see test/debug-gate.test.js) — same pattern as
// server/auth.js + server/livekit.js. Behaviour is identical to the original
// inline function.
//
// The gate decides whether the request may load the client debug panel. The
// server only injects `<script src="/client/debug.js">` into index.html when
// this returns true, so normal players never receive the debug code.
//
// - Local dev (DEBUG_KEY unset): allowed only from localhost/loopback.
// - Live (DEBUG_KEY set): requires ?key= to match the secret, OR loopback.

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Read once at module load. Changing process.env.DEBUG_KEY after import has no
// effect (mirrors the original behaviour). Tests save/restore the env around
// each case.
const DEBUG_KEY = process.env.DEBUG_KEY || "";

/**
 * @returns {boolean} true if this request may load the debug client.
 */
export function debugAllowed(req) {
  const rawQuery = (req.url || "").split("?")[1] || "";
  const params = new URLSearchParams(rawQuery);
  if (params.get("debug") !== "1") return false;            // must opt in
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const isLoopback = LOOPBACK.has(remote);
  if (!DEBUG_KEY) return isLoopback;                         // local: loopback only
  return params.get("key") === DEBUG_KEY || isLoopback;      // live: key OR loopback
}

/**
 * Re-evaluate the gate against a freshly-read DEBUG_KEY. Used by tests so they
 * can flip the env between cases without reloading the module. Not used at
 * runtime — runtime reads once at startup, above.
 */
export function debugAllowedWith(key, req) {
  const rawQuery = (req.url || "").split("?")[1] || "";
  const params = new URLSearchParams(rawQuery);
  if (params.get("debug") !== "1") return false;
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const isLoopback = LOOPBACK.has(remote);
  if (!key) return isLoopback;
  return params.get("key") === key || isLoopback;
}
