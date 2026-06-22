// End-to-end test of the debug-panel gate as actually wired into the HTTP
// request handler. Unlike test/debug-gate.test.js (which unit-tests the pure
// gate function), this spawns the REAL server in a child process and makes real
// HTTP requests — verifying the gate's result drives the <script> injection in
// index.html. Run with `npm test`.
//
// We spawn a subprocess rather than importing server/index.js because index.js
// calls server.listen() on import and registers SIGTERM/SIGINT handlers; a
// subprocess with its own ephemeral PORT isolates us cleanly and matches how
// the server actually runs in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "server", "index.js");

const DEBUG_TAG = '<script src="/debug.js"></script>';
const HELPER_TAG = '<script src="/debug-helpers.js"></script>';

// Fetch a path on the given origin. Returns { status, body, headers }.
function get(origin, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin + path, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

// Grab a free TCP port from the OS by binding to :0, then closing. There's a
// tiny race before the child rebinds, but it's fine for tests.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Start the server with a given DEBUG_KEY on a fresh ephemeral port. Resolves
// to { origin, stop }. We pass an explicit PORT (not 0) because the server's
// startup banner prints the requested PORT variable, not server.address().port.
function startServer(debugKey) {
  return new Promise(async (resolve, reject) => {
    let port;
    try { port = await freePort(); } catch (e) { return reject(e); }
    const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1" };
    if (debugKey !== undefined) env.DEBUG_KEY = debugKey;
    else delete env.DEBUG_KEY;
    const child = spawn(process.execPath, [SERVER], { env });
    let started = false;
    child.on("error", (err) => { if (!started) reject(err); });
    child.on("exit", (code, signal) => {
      if (!started) reject(new Error(`server exited (code ${code}, signal ${signal}) before startup`));
    });
    child.stdout.on("data", (chunk) => {
      const line = chunk.toString();
      // Wait for our known banner line (uses the explicit port we passed).
      if (!started && line.includes("Mega Mindikot 5v5")) {
        started = true;
        resolve({
          origin: `http://127.0.0.1:${port}`,
          stop: () => { child.kill("SIGTERM"); return waitForExit(child); },
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!started) console.error("[server stderr]", chunk.toString());
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) return resolve();
    child.once("exit", () => resolve());
  });
}

test("local server (DEBUG_KEY unset): GET / has no debug tag", async () => {
  const { origin, stop } = await startServer(undefined);
  try {
    const res = await get(origin, "/");
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(DEBUG_TAG), "plain GET / must not serve the debug script");
  } finally {
    await stop();
  }
});

test("local server: GET /?debug=1 injects the debug tag", async () => {
  const { origin, stop } = await startServer(undefined);
  try {
    const res = await get(origin, "/?debug=1");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(DEBUG_TAG), "?debug=1 from loopback must inject the debug script");
    // The helper script must also be present and load BEFORE debug.js.
    const helperIdx = res.body.indexOf(HELPER_TAG);
    const debugIdx = res.body.indexOf(DEBUG_TAG);
    assert.ok(helperIdx !== -1, "helper script tag must be present");
    assert.ok(debugIdx !== -1, "debug script tag must be present");
    assert.ok(helperIdx < debugIdx, "debug-helpers.js must load before debug.js");
    // CRITICAL: both debug scripts must load BEFORE client.js. client.js runs
    // `if (window.__dbg) hook(...)` at the bottom of the file; if debug.js
    // hasn't set window.__dbg yet, the panel never arms. Classic scripts run in
    // document order, so position in the HTML determines execution order.
    const clientIdx = res.body.indexOf('<script src="/client.js">');
    assert.ok(clientIdx !== -1, "client.js script tag must be present");
    assert.ok(debugIdx < clientIdx, "debug.js MUST load before client.js (else the panel never arms)");
  } finally {
    await stop();
  }
});

test("local server: the debug-helpers.js file is served (flat URL)", async () => {
  // Regression guard: client files are served FLAT from CLIENT_DIR (client/),
  // so the URL is /debug-helpers.js — NOT /client/debug-helpers.js (that 404s).
  const { origin, stop } = await startServer(undefined);
  try {
    const res = await get(origin, "/debug-helpers.js");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("buildSnapshot"), "helper source must be served");
    assert.match(res.headers["content-type"] || "", /javascript/, "served as JS mime");
    // And the wrong nested path must 404 — so a future regression to the
    // nested form is caught.
    const wrong = await get(origin, "/client/debug-helpers.js");
    assert.equal(wrong.status, 404, "/client/* must 404 (flat serving)");
  } finally {
    await stop();
  }
});

test("live server (DEBUG_KEY set): loopback with no key still injects (loopback-wins)", async () => {
  const { origin, stop } = await startServer("live-secret-key");
  try {
    // On loopback the gate allows even without the key, so the tag IS injected.
    // This documents the loopback-wins behaviour; the remote-blocked case is
    // covered by debug-gate.test.js (which can forge a non-loopback peer).
    const res = await get(origin, "/?debug=1");
    assert.ok(res.body.includes(DEBUG_TAG), "loopback always wins even on a live server");
  } finally {
    await stop();
  }
});

test("live server: GET / with no ?debug=1 never injects, even from loopback", async () => {
  const { origin, stop } = await startServer("live-secret-key");
  try {
    const res = await get(origin, "/");
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(DEBUG_TAG), "no opt-in means no debug tag, ever");
  } finally {
    await stop();
  }
});

test("only index.html gets the debug tag, not other served files", async () => {
  const { origin, stop } = await startServer(undefined);
  try {
    // debug-helpers.js is a real .js file; even with ?debug=1 it must not be
    // rewritten (injection is gated on url === "/index.html").
    const res = await get(origin, "/debug-helpers.js?debug=1");
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(DEBUG_TAG), "non-index files must never get the debug tag");
    assert.ok(res.body.includes("buildSnapshot"), "the real helper source is still served");
  } finally {
    await stop();
  }
});

test("path traversal (..) is rejected with 403 or 404", async () => {
  const { origin, stop } = await startServer(undefined);
  try {
    const res = await get(origin, "/../package.json");
    // Either 403 (caught by the explicit check) or 404 (join normalizes) —
    // both are safe. The key invariant: the file is NOT served.
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    assert.ok(!res.body.includes("dependencies"), "package.json contents must not leak");
  } finally {
    await stop();
  }
});
