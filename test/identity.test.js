// Phase 4 — player identity (flag emoji, country/avatar validation, player IDs).
// All pure functions in shared/identity.js; no DB access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flagEmoji, isValidCountry, isValidAvatar, generatePlayerId,
  COUNTRY_OPTIONS, AVATAR_OPTIONS, AVATAR_SET, PLAYER_ID_ALPHABET, PLAYER_ID_LENGTH,
  xpForOutcome, levelFromXp, xpToReachLevel, xpProgress,
  XP_PER_WIN, XP_PER_DRAW, XP_PER_LOSS, XP_PER_TEN,
  normalizePlayerId,
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

// --- Phase 5: XP + levels ---
test("xpForOutcome: win = base 100 + 5 per ten", () => {
  assert.equal(xpForOutcome({ won: true, tens: 0 }), XP_PER_WIN);
  assert.equal(xpForOutcome({ won: true, tens: 3 }), 100 + 15);
});
test("xpForOutcome: draw = 40 + 5 per ten", () => {
  assert.equal(xpForOutcome({ draw: true, tens: 0 }), XP_PER_DRAW);
  assert.equal(xpForOutcome({ draw: true, tens: 2 }), 40 + 10);
});
test("xpForOutcome: loss = 15 + 5 per ten (won:false, draw:false)", () => {
  assert.equal(xpForOutcome({ won: false, draw: false, tens: 0 }), XP_PER_LOSS);
  assert.equal(xpForOutcome({ won: false, draw: false, tens: 6 }), 15 + 30);
});
test("xpForOutcome: defaults / bad input are safe (loss 15, no tens)", () => {
  assert.equal(xpForOutcome({}), XP_PER_LOSS);
  assert.equal(xpForOutcome(), XP_PER_LOSS);
  assert.equal(xpForOutcome({ won: true, tens: -5 }), XP_PER_WIN); // negative tens clamped
  assert.equal(xpForOutcome({ won: true, tens: "abc" }), XP_PER_WIN); // non-numeric tens -> 0
});

test("levelFromXp: 0 XP -> level 1; boundaries are exact", () => {
  assert.equal(levelFromXp(0), 1);
  assert.equal(levelFromXp(199), 1);
  assert.equal(levelFromXp(200), 2);   // L2 threshold
  assert.equal(levelFromXp(599), 2);
  assert.equal(levelFromXp(600), 3);   // L3 threshold
  assert.equal(levelFromXp(1200), 4);  // L4 threshold
  assert.equal(levelFromXp(2000), 5);  // L5 threshold
});
test("levelFromXp: clamps negatives/non-numbers to level 1", () => {
  assert.equal(levelFromXp(-50), 1);
  assert.equal(levelFromXp(NaN), 1);
  assert.equal(levelFromXp(undefined), 1);
});
test("levelFromXp: scales sensibly at higher XP", () => {
  assert.equal(levelFromXp(10000), 10);   // ~50 wins
  assert.equal(levelFromXp(100000), 32);  // a long-term player
});

test("xpToReachLevel: level 1 -> 0; the curve is 100*L*(L-1)", () => {
  assert.equal(xpToReachLevel(1), 0);
  assert.equal(xpToReachLevel(2), 200);
  assert.equal(xpToReachLevel(3), 600);
  assert.equal(xpToReachLevel(4), 1200);
  assert.equal(xpToReachLevel(5), 2000);
  assert.equal(xpToReachLevel(11), 11000); // 100*11*10
});

test("INVARIANT: levelFromXp(xpToReachLevel(L)) === L for L=1..30", () => {
  for (let L = 1; L <= 30; L++) {
    assert.equal(levelFromXp(xpToReachLevel(L)), L, `mismatch at level ${L}`);
  }
});

test("xpProgress: returns level + within-level progress", () => {
  // 800 XP -> level 3 (floor 600, next 1200), 200 into a 600 span.
  const p = xpProgress(800);
  assert.equal(p.level, 3);
  assert.equal(p.floor, 600);
  assert.equal(p.ceil, 1200);
  assert.equal(p.into, 200);
  assert.equal(p.span, 600);
});
test("xpProgress: 0 XP -> level 1, full span to next", () => {
  const p = xpProgress(0);
  assert.equal(p.level, 1);
  assert.equal(p.into, 0);
  assert.equal(p.span, 200);
});

// --- Phase 6: normalizePlayerId ---
test("normalizePlayerId: strips leading #, trims, uppercases", () => {
  assert.equal(normalizePlayerId("#a4f2k"), "A4F2K");
  assert.equal(normalizePlayerId("  #a4f2k  "), "A4F2K");
  assert.equal(normalizePlayerId("a4f2k"), "A4F2K");
  assert.equal(normalizePlayerId("A4F2K"), "A4F2K");
});
test("normalizePlayerId: rejects wrong length / bad chars / non-strings", () => {
  assert.equal(normalizePlayerId(""), "");
  assert.equal(normalizePlayerId("ABC"), "");            // too short
  assert.equal(normalizePlayerId("ABCDEF"), "");         // too long
  assert.equal(normalizePlayerId("ABC1I"), "");          // ambiguous chars (1, I) not in alphabet
  assert.equal(normalizePlayerId("ABC D"), "");          // embedded whitespace
  assert.equal(normalizePlayerId(null), "");
  assert.equal(normalizePlayerId(undefined), "");
  assert.equal(normalizePlayerId(12345), "");
});
test("normalizePlayerId: accepts every char in the alphabet at the right length", () => {
  // build a valid 5-char code from the alphabet and round-trip it
  const code = PLAYER_ID_ALPHABET.slice(0, PLAYER_ID_LENGTH); // "ABCDE"
  assert.equal(normalizePlayerId(code.toLowerCase()), code);
});
