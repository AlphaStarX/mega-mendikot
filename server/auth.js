// Mega Mendikot 5v5 — account authentication (zero-dependency crypto).
//
// Deliberately uses only node:crypto, matching the project's hand-rolled ethos
// (see server/livekit.js, which hand-rolls LiveKit JWTs the same way):
//   - Password hashing: scrypt (a modern, slow KDF). NOT bcrypt, NOT plain SHA.
//   - Session tokens:   HS256 JWTs signed with node:crypto.
//
// Fail-soft: if JWT_SECRET / DATABASE_URL are unset, authConfigured() returns false
// and the game plays anonymously exactly as before.

import crypto from "node:crypto";

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days — "remember me" style sessions
const SCRYPT_KEYLEN = 64;                 // 512-bit derived key
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** True iff both JWT_SECRET and DATABASE_URL are set (auth can function). */
export function authConfigured() {
  return !!(process.env.JWT_SECRET && process.env.DATABASE_URL);
}

// --- password hashing (scrypt) ---

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

/**
 * Hash a plaintext password with scrypt + a fresh per-user salt.
 * @param {string} plain
 * @returns {Promise<{passwordHash: string, passwordSalt: string}>} both base64
 */
export function hashPassword(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) return reject(err);
      resolve({ passwordHash: b64(derived), passwordSalt: b64(salt) });
    });
  });
}

/**
 * Verify a plaintext password against a stored scrypt hash + salt.
 * Constant-time comparison via timingSafeEqual.
 * @param {string} plain
 * @param {string} storedHash  base64
 * @param {string} storedSalt  base64
 * @returns {Promise<boolean>}
 */
export function verifyPassword(plain, storedHash, storedSalt) {
  return new Promise((resolve, reject) => {
    const salt = unb64(storedSalt);
    const expected = unb64(storedHash);
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) return reject(err);
      if (derived.length !== expected.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derived, expected));
    });
  });
}

// --- session tokens (HS256 JWT) ---

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign a session JWT for an authenticated user.
 * @param {{userId: string, email: string}} payload
 * @returns {string} signed JWT
 */
export function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    iat: now,
    exp: now + TOKEN_TTL_SEC,
  };
  const encHeader = b64url(JSON.stringify(header));
  const encBody = b64url(JSON.stringify(body));
  const signingInput = `${encHeader}.${encBody}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Verify a JWT's signature and expiry. Returns the payload or null.
 * @param {string} token
 * @returns {{userId: string, email: string, exp: number} | null}
 */
export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encBody, signature] = parts;
  const signingInput = `${encHeader}.${encBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  // Constant-time compare of the signature.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encBody, "base64url").toString());
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

// --- input validation ---

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate signup input. Returns an error string or null if valid. */
export function validateSignup({ email, password, name }) {
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
    return "Please enter a valid email address.";
  }
  if (email.length > 254) return "Email is too long.";
  if (!password || typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 200) return "Password is too long.";
  if (!name || typeof name !== "string" || name.trim().length < 1) {
    return "Please choose a display name.";
  }
  if (name.trim().length > 20) return "Display name must be 20 characters or fewer.";
  return null;
}

/** Normalize/sanitize a display name. */
export function cleanName(name) {
  return String(name || "").trim().slice(0, 20) || "Player";
}

/** Lowercase + trim an email for storage/lookup (case-insensitive uniqueness). */
export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
