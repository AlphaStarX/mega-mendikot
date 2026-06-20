// Mega Mindikot 5v5 — LiveKit voice integration (master spec v1.3.x, §6.1 "LiveKit Voice Chat")
//
// Team-scoped voice chat. Team is derived server-side from the seat (§2.2/§2.10),
// and a human at seat S is placed into a LiveKit room named `mm_{roomId}_{team}`,
// so opponents live in a different room and can never subscribe to your audio.
//
// This module is deliberately zero-dependency: LiveKit access tokens are signed
// JWTs (HS256) and are minted here with node:crypto only, matching the project's
// hand-rolled ethos. When the three LIVEKIT_* env vars are unset, voiceConfigured()
// returns false and the entire feature no-ops — the game plays exactly as it does
// without voice.

import crypto from "node:crypto";

const TOKEN_TTL_SEC = 2 * 60 * 60; // 2h — comfortably outlasts any single match

// LiveKit access tokens are signed JWTs. See LiveKit AccessToken claim schema:
//   header  : { alg: "HS256", typ: "JWT" }
//   payload : { v, iss, sub, nbf, exp, video: { roomJoin, room, canPublish, canSubscribe } }
// The signature is HMAC-SHA256 over `base64url(header).base64url(payload)`.
function b64url(input) {
  // input may be a string or a Buffer; normalize to a Buffer then base64url-encode.
  return Buffer.from(input).toString("base64url");
}

/**
 * Mint a LiveKit access token for one participant to join one team-scoped room.
 * @param {{apiKey:string, apiSecret:string, room:string, identity:string, name?:string, ttlSec?:number}} opts
 * @returns {string} signed JWT string (HS256)
 */
export function makeLiveKitToken({ apiKey, apiSecret, room, identity, name, ttlSec }) {
  const ttl = ttlSec || TOKEN_TTL_SEC;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    v: 2, // LiveKit token version
    iss: apiKey,
    sub: identity,
    nbf: now,
    exp: now + ttl,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    },
    // LiveKit accepts a display name via the `name` top-level claim.
    ...(name ? { name } : {}),
  };

  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * True iff the three required env vars are set. Used everywhere to gate the
 * feature so that an unconfigured deployment behaves identically to pre-voice.
 */
export function voiceConfigured() {
  return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL);
}

/**
 * @returns {{apiKey:string, apiSecret:string, url:string} | null} config or null if unconfigured.
 */
export function voiceConfig() {
  if (!voiceConfigured()) return null;
  return {
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    url: process.env.LIVEKIT_URL,
  };
}

/**
 * Build the team-scoped LiveKit room name for a given game room + team.
 * Opposing teams get different names -> structural audio isolation.
 * Room ids are 4 unambiguous chars (A-Z2-9, no IO01), so they're LiveKit-room-safe.
 */
export function voiceRoomName(roomId, team) {
  return `mm_${roomId}_${team}`;
}
