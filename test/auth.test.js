// Tests for the zero-dependency auth module (scrypt password hashing + HS256 JWT).
// Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  authConfigured,
  validateSignup,
  cleanName,
  normalizeEmail,
} from "../server/auth.js";

const JWT_SECRET = "test-secret-for-jwt-signing-1234567890";

function withSecret(fn) {
  return async () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = saved;
    }
  };
}

// --- password hashing (scrypt) ---

test("hashPassword + verifyPassword round-trips a correct password", async () => {
  const { passwordHash, passwordSalt } = await hashPassword("correct horse battery");
  assert.ok(passwordHash && passwordSalt);
  assert.ok(passwordHash !== passwordSalt, "hash and salt differ");
  assert.equal(await verifyPassword("correct horse battery", passwordHash, passwordSalt), true);
});

test("verifyPassword rejects a wrong password", async () => {
  const { passwordHash, passwordSalt } = await hashPassword("the-right-one");
  assert.equal(await verifyPassword("the-wrong-one", passwordHash, passwordSalt), false);
  assert.equal(await verifyPassword("therightone", passwordHash, passwordSalt), false);
});

test("hashPassword produces a unique salt per call (same password, different hash)", async () => {
  const a = await hashPassword("samepassword");
  const b = await hashPassword("samepassword");
  assert.notEqual(a.passwordHash, b.passwordHash, "salts must differ");
  assert.notEqual(a.passwordSalt, b.passwordSalt);
});

// --- session tokens (HS256 JWT) ---

test("signToken + verifyToken round-trips a payload", withSecret(async () => {
  const token = signToken({ userId: "user-123", email: "a@b.com" });
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.userId, "user-123");
  assert.equal(payload.email, "a@b.com");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), "token not expired");
}));

test("verifyToken rejects a tampered payload (signature mismatch)", withSecret(async () => {
  const token = signToken({ userId: "user-123", email: "a@b.com" });
  // Flip a character in the payload section.
  const [h, p, s] = token.split(".");
  const tampered = `${h}.${p.replace(/^./, p.charCodeAt(0) === 97 ? "b" : "a")}.${s}`;
  assert.equal(verifyToken(tampered), null);
}));

test("verifyToken rejects a malformed token", withSecret(async () => {
  assert.equal(verifyToken("not.a.valid.token"), null);
  assert.equal(verifyToken("onlyonepart"), null);
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(""), null);
}));

test("verifyToken rejects a token signed with a different secret", async () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "secret-A";
  const token = signToken({ userId: "u1", email: "a@b.com" });
  process.env.JWT_SECRET = "secret-B";
  assert.equal(verifyToken(token), null, "token from secret A must fail under secret B");
  if (saved === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = saved;
});

test("authConfigured is false when env vars are unset", () => {
  const saved = { JWT_SECRET: process.env.JWT_SECRET, DATABASE_URL: process.env.DATABASE_URL };
  delete process.env.JWT_SECRET;
  delete process.env.DATABASE_URL;
  assert.equal(authConfigured(), false);
  process.env.JWT_SECRET = "k";
  assert.equal(authConfigured(), false, "still false without DATABASE_URL");
  process.env.DATABASE_URL = "postgresql://x";
  assert.equal(authConfigured(), true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- input validation ---

test("validateSignup accepts valid input", () => {
  assert.equal(validateSignup({ email: "a@b.com", password: "longenough", name: "Alice" }), null);
});

test("validateSignup rejects bad email / short password / empty name", () => {
  assert.ok(validateSignup({ email: "notanemail", password: "longenough", name: "Alice" }));
  assert.ok(validateSignup({ email: "a@b.com", password: "short", name: "Alice" }));
  assert.ok(validateSignup({ email: "a@b.com", password: "longenough", name: "" }));
  assert.ok(validateSignup({ email: "a@b.com", password: "longenough", name: "   " }));
  assert.ok(validateSignup({ email: "a@b.com", password: "longenough", name: "x".repeat(21) }));
});

test("cleanName trims and truncates", () => {
  assert.equal(cleanName("  Alice  "), "Alice");
  assert.equal(cleanName("x".repeat(30)), "x".repeat(20));
  assert.equal(cleanName(""), "Player");
  assert.equal(cleanName(null), "Player");
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
});
