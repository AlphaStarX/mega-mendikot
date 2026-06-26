// Phase 4 — player identity (flag emoji, country/avatar validation, player IDs).
// All pure functions in shared/identity.js; no DB access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flagEmoji, isValidCountry, isValidAvatar, generatePlayerId,
  COUNTRY_OPTIONS, AVATAR_OPTIONS, AVATAR_SET, PLAYER_ID_ALPHABET, PLAYER_ID_LENGTH,
} from "../shared/identity.js";

// --- flagEmoji ---
test("flagEmoji: US -> 🇺🇸 (regional indicator pair)", () => {
  assert.equal(flagEmoji("US"), "🇺🇸");
});
test("flagEmoji: IN -> 🇮🇳", () => { assert.equal(flagEmoji("IN"), "🇮🇳"); });
test("flagEmoji: lowercase input is uppercased", () => { assert.equal(flagEmoji("us"), "🇺🇸"); });
test("flagEmoji: empty/null/undefined -> empty string", () => {
  assert.equal(flagEmoji(""), "");
  assert.equal(flagEmoji(null), "");
  assert.equal(flagEmoji(undefined), "");
  assert.equal(flagEmoji(123), "");
});
test("flagEmoji: non-2-letter input -> empty string", () => {
  assert.equal(flagEmoji("USA"), "");
  assert.equal(flagEmoji("X1"), "");
  assert.equal(flagEmoji("X"), "");
});
test("flagEmoji: produces exactly 2 code points (a regional indicator pair)", () => {
  // The flag is a single grapheme cluster but two Unicode code points. Use the
  // spread to split by code point (codePointAt(1) would land on a surrogate).
  const cps = [...flagEmoji("GB")];
  assert.equal(cps.length, 2);
  assert.ok(cps[0].codePointAt(0) >= 0x1f1e6 && cps[0].codePointAt(0) <= 0x1f1ff);
  assert.ok(cps[1].codePointAt(0) >= 0x1f1e6 && cps[1].codePointAt(0) <= 0x1f1ff);
});

// --- isValidCountry ---
test("isValidCountry: known codes true (case-insensitive)", () => {
  assert.equal(isValidCountry("US"), true);
  assert.equal(isValidCountry("us"), true);
  assert.equal(isValidCountry("IN"), true);
});
test("isValidCountry: junk codes false", () => {
  assert.equal(isValidCountry("XX"), false);
  assert.equal(isValidCountry(""), false);
  assert.equal(isValidCountry(null), false);
  assert.equal(isValidCountry("USA"), false);
});

// --- isValidAvatar ---
test("isValidAvatar: palette members true", () => {
  assert.equal(isValidAvatar(AVATAR_OPTIONS[0]), true);
  assert.equal(isValidAvatar("🦊"), true);
});
test("isValidAvatar: non-palette emoji + junk false", () => {
  assert.equal(isValidAvatar("🍕"), false);   // a real emoji but not in the palette
  assert.equal(isValidAvatar("not an emoji"), false);
  assert.equal(isValidAvatar(""), false);
  assert.equal(isValidAvatar(null), false);
});
test("isValidAvatar: AVATAR_SET matches AVATAR_OPTIONS", () => {
  for (const e of AVATAR_OPTIONS) assert.ok(AVATAR_SET.has(e));
});

// --- generatePlayerId ---
test("generatePlayerId: correct length", () => {
  const id = generatePlayerId();
  assert.equal(id.length, PLAYER_ID_LENGTH);
});
test("generatePlayerId: only unambiguous characters", () => {
  // Generate several; every char must be in the alphabet (no I/O/0/1).
  for (let i = 0; i < 50; i++) {
    const id = generatePlayerId();
    for (const ch of id) assert.ok(PLAYER_ID_ALPHABET.includes(ch), `bad char ${ch} in ${id}`);
  }
});
test("generatePlayerId: produces variety (not the same id every time)", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(generatePlayerId());
  // With a 32-char alphabet and length 5, collisions across 100 draws are
  // astronomically unlikely; this just guards against a degenerate constant.
  assert.ok(ids.size > 1, "expected variety in generated ids");
});

// --- data sanity ---
test("COUNTRY_OPTIONS: every entry has a 2-letter uppercase code + a name", () => {
  for (const c of COUNTRY_OPTIONS) {
    assert.match(c.code, /^[A-Z]{2}$/);
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0);
  }
});
test("COUNTRY_OPTIONS: codes are unique", () => {
  const codes = COUNTRY_OPTIONS.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
});
test("flagEmoji: every country code in the list produces a flag", () => {
  for (const c of COUNTRY_OPTIONS) assert.ok(flagEmoji(c.code).length > 0, `no flag for ${c.code}`);
});
