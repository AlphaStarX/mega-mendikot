// Tests for the zero-dependency LiveKit token minter (master spec v1.3.x).
// Verifies JWT structure, team-scoped room claim, signature validity, and the
// voiceConfigured() gate. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  makeLiveKitToken,
  voiceConfigured,
  voiceConfig,
  voiceRoomName,
} from "../server/livekit.js";

const API_KEY = "API-test-key";
const API_SECRET = "super-secret-test-value-32+chars-long";

function decodeJwt(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have 3 dot-separated parts");
  const [header, payload, signature] = parts;
  const headerObj = JSON.parse(Buffer.from(header, "base64url").toString());
  const payloadObj = JSON.parse(Buffer.from(payload, "base64url").toString());
  const signingInput = `${header}.${payload}`;
  const expectedSig = crypto.createHmac("sha256", API_SECRET).update(signingInput).digest("base64url");
  return { header: headerObj, payload: payloadObj, signature, expectedSig };
}

test("makeLiveKitToken produces an HS256 JWT with correct claims", () => {
  const token = makeLiveKitToken({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    room: "mm_ABCD_A",
    identity: "seat0-session-abc",
    name: "Alice",
  });
  const { header, payload, signature, expectedSig } = decodeJwt(token);

  assert.equal(header.alg, "HS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, API_KEY);
  assert.equal(payload.sub, "seat0-session-abc");
  assert.equal(payload.name, "Alice");
  assert.equal(payload.v, 2);
  assert.ok(payload.nbf, "has nbf");
  assert.ok(payload.exp > payload.nbf, "exp is after nbf");
  // Team-scoped room claim — opponents land in a different room.
  assert.equal(payload.video.roomJoin, true);
  assert.equal(payload.video.room, "mm_ABCD_A");
  assert.equal(payload.video.canPublish, true);
  assert.equal(payload.video.canSubscribe, true);
  // Signature must verify against the secret.
  assert.equal(signature, expectedSig);
});

test("two teams get different room claims -> structural audio isolation", () => {
  const a = makeLiveKitToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: "mm_ABCD_A", identity: "x" });
  const b = makeLiveKitToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: "mm_ABCD_B", identity: "y" });
  const pa = JSON.parse(Buffer.from(a.split(".")[1], "base64url").toString());
  const pb = JSON.parse(Buffer.from(b.split(".")[1], "base64url").toString());
  assert.notEqual(pa.video.room, pb.video.room, "teams must not share a LiveKit room");
});

test("signature fails verification if the secret differs (anti-forge)", () => {
  const token = makeLiveKitToken({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    room: "mm_X_A",
    identity: "z",
  });
  const [, , sig] = token.split(".");
  const wrongSig = crypto.createHmac("sha256", "different-secret").update(token.split(".").slice(0, 2).join(".")).digest("base64url");
  assert.notEqual(sig, wrongSig);
});

test("voiceRoomName maps (room, team) deterministically", () => {
  assert.equal(voiceRoomName("ABCD", "A"), "mm_ABCD_A");
  assert.equal(voiceRoomName("ABCD", "B"), "mm_ABCD_B");
  assert.notEqual(voiceRoomName("ABCD", "A"), voiceRoomName("ABCD", "B"));
});

test("voiceConfigured is false when env vars are unset", () => {
  // Save and clear any live env so this test is deterministic.
  const saved = {
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
  };
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_URL;
  assert.equal(voiceConfigured(), false);
  assert.equal(voiceConfig(), null);

  process.env.LIVEKIT_API_KEY = "k";
  process.env.LIVEKIT_API_SECRET = "s";
  process.env.LIVEKIT_URL = "wss://lk.example.com";
  assert.equal(voiceConfigured(), true);
  const cfg = voiceConfig();
  assert.deepEqual(cfg, { apiKey: "k", apiSecret: "s", url: "wss://lk.example.com" });

  // Restore.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
