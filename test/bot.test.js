// Mega Mindikot 5v5 — bot AI unit tests. Run with `npm test`.
//
// Exercises selectBotPlayCard directly with hand-crafted inputs (no GameRoom,
// no timers, no WebSocket) — the same pure function game-room.botPlay() calls.
// Fast (milliseconds) and targeted at each heuristic in the spec (§4).
//
// Philosophy: spec-authoritative for clearly-specified rules; characterization
// (lock-in current behavior) where the spec is silent or where the code invents
// a non-spec rule. Such tests carry a "CHARACTERIZATION:" note explaining why
// they assert an implementation choice rather than a spec rule. No production
// code is changed by this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectBotPlayCard } from "../shared/bot.js";
import { SUITS } from "../shared/rules.js";

// ---------- helpers ----------
// A card needs an id because selectBotPlayCard returns the same object it was
// given, and resolveTrickWinner (used internally) keys off suit/rank; id keeps
// assertions readable and matches the real card shape.
function card(suit, rank) { return { id: `${suit}_${rank}`, suit, rank }; }
function handOf(...cards) { return cards; }
// playedCards entry: { seat, card, playOrder }. playOrder drives tie-breaking.
function played(seat, c, playOrder) { return { seat, card: c, playOrder }; }
function trickOf(leadSuit, playedCards) { return { leadSuit, playedCards }; }

// The 10-seat team map the room passes: evens = Team A, odds = Team B.
function seats() {
  return Array.from({ length: 10 }, (_, i) => ({ team: i % 2 === 0 ? "A" : "B" }));
}
// Thin wrapper around the 7-arg contract. Defaults the bot to seat 0 (Team A),
// no trump, scores 0-0. Override via the single opts arg.
function call(hand, trick, opts = {}) {
  const {
    seat = 0, trump = "", scoreA = 0, scoreB = 0,
  } = opts;
  return selectBotPlayCard(hand, trick, seat, trump, seats(), scoreA, scoreB);
}

// Convenience suit aliases for readability.
const S = SUITS; // ["SPADES","HEARTS","DIAMONDS","CLUBS"]

// ---------- LEAD heuristics (§4.1) ----------
// isLead is true when playedCards is empty (and/or no leadSuit yet).

test("L-1 Bleed Trumps: with trump set, leads a high trump it holds", () => {
  // Trump = HEARTS; bot holds A♥ and K♥ plus low off-suit filler.
  const hand = handOf(card(S[1], 14), card(S[1], 13), card(S[0], 8), card(S[2], 7));
  const pick = call(hand, trickOf("", []), { trump: S[1] });
  assert.equal(pick.suit, S[1], "leads a trump");
  // CHARACTERIZATION: spec says "Ace or King" without disambiguating; code
  // prefers the highest rank (Ace). We assert rank>=13 to honor the spec's
  // "Ace or King" while not over-constraining the silent Ace-vs-King tie.
  assert.ok(pick.rank >= 13, `leads A/K of trump (got rank ${pick.rank})`);
});

test("L-2 Bait Trump: no trump + long suit (>=5) leads a low (7/8) of it", () => {
  // 5 SPADES including a 7 and 8; no trump established.
  const hand = handOf(
    card(S[0], 7), card(S[0], 8), card(S[0], 9), card(S[0], 11), card(S[0], 12),
    card(S[1], 14), card(S[2], 9), card(S[3], 9),
  );
  const pick = call(hand, trickOf("", []));
  assert.equal(pick.suit, S[0], "leads the long suit");
  assert.ok(pick.rank === 7 || pick.rank === 8, `leads a low bait card (got ${pick.rank})`);
});

test("L-3 Lead Aces: no trump, no long suit, holds an off-suit Ace -> leads it", () => {
  // No suit has >=5 cards; holds the SPADES Ace.
  const hand = handOf(card(S[0], 14), card(S[0], 9), card(S[1], 9), card(S[2], 9), card(S[3], 9));
  const pick = call(hand, trickOf("", []));
  assert.equal(pick.rank, 14, "leads an Ace");
  assert.notEqual(pick.suit, "", "ace has a real suit");
});

test("L-4 Weak Lead: only low cards -> leads lowest of weakest suit", () => {
  // Make the weakest suit unambiguous: DIAMONDS has the fewest cards (just the 7)
  // while the others have two. No A/K, no suit with >=5 -> falls through to L-4.
  // L-4 = "lowest of the weakest (fewest-card) suit".
  const hand = handOf(card(S[0], 9), card(S[0], 8), card(S[1], 9), card(S[1], 8), card(S[2], 7));
  const pick = call(hand, trickOf("", []));
  assert.equal(pick.suit, S[2], "picks the weakest (fewest-card) suit");
  assert.equal(pick.rank, 7, "lowest card of that weakest suit");
});

// ---------- FOLLOW heuristics (§4.2) ----------

test("F-1 Save Power: teammate winning -> play lowest lead-suit card", () => {
  // Bot is seat 0 (Team A). Teammate is seat 2 (Team A) and is winning with J♥.
  const lead = S[1];
  const hand = handOf(card(lead, 9), card(lead, 10), card(lead, 14), card(S[0], 7));
  const trick = trickOf(lead, [played(2, card(lead, 11), 0)]); // teammate (seat 2) leads J♥
  const pick = call(hand, trick, { seat: 0 });
  assert.equal(pick.suit, lead, "follows lead suit");
  assert.equal(pick.rank, 9, "saves power: lowest lead-suit card");
});

test("F-2 Discard 10s: teammate winning high + late order + holds 10 -> play the 10", () => {
  // Bot seat 0 (Team A). Teammate seat 2 winning with A♥. Bot is last-ish in
  // order (playOrder >= 7) and holds a 10 of lead suit -> secure the point.
  const lead = S[1];
  const hand = handOf(card(lead, 10), card(lead, 7), card(lead, 8), card(S[0], 9));
  // Build 8 prior plays so the bot's own playOrder will be >= 7.
  const prior = [];
  // seat 2 = teammate, plays A♥ (rank 14) and is the current winner
  prior.push(played(2, card(lead, 14), 0));
  // seven more (opponent/teammate) lead-suit followers to push playOrder up
  for (let i = 0; i < 7; i++) prior.push(played((i % 2 === 0) ? 1 : 4, card(lead, 9), i + 1));
  const trick = trickOf(lead, prior);
  const pick = call(hand, trick, { seat: 0 });
  assert.equal(pick.suit, lead, "still lead suit");
  assert.equal(pick.rank, 10, "secures the point by playing the 10");
});

test("F-3 Beat Opponent: opp winning + 10 in trick -> lowest card that beats", () => {
  // Bot seat 0 (Team A). Opponent seat 1 (Team B) winning with J♥. A 10 is
  // already in the trick. Bot holds Q♥ and 9♥ -> should play Q♥ (lowest beater).
  const lead = S[1];
  const hand = handOf(card(lead, 12), card(lead, 9), card(lead, 10), card(S[0], 7));
  const trick = trickOf(lead, [
    played(1, card(lead, 11), 0), // opponent winning J♥
    played(3, card(lead, 10), 1), // a 10 (point) is in the trick
  ]);
  const pick = call(hand, trick, { seat: 0 });
  assert.ok(pick.rank > 11, `beats the opponent's J (got ${pick.rank})`);
  assert.equal(pick.rank, 12, "plays the LOWEST card that beats, not the Ace");
});

test("F-3 Concede: opp winning + NO 10 in trick -> lowest lead-suit (save power)", () => {
  // Opponent winning with J♥, but no point (10) in the trick. Bot could beat
  // with Q♥ but should instead save power and dump the 9♥.
  const lead = S[1];
  const hand = handOf(card(lead, 12), card(lead, 9), card(S[0], 7));
  const trick = trickOf(lead, [played(1, card(lead, 11), 0)]); // opp J♥, no 10 anywhere
  const pick = call(hand, trick, { seat: 0 });
  assert.equal(pick.rank, 9, "no point at stake -> saves power with lowest lead card");
});

// ---------- TRUMP declaration (§4.3) ----------
// Reached when the bot cannot follow suit AND trump is not yet established.

test("T-1 Declare Strong Suit: can't follow + >=4 of a suit with A/K -> lowest of it", () => {
  // Lead is SPADES; bot has no SPADES. Holds 4 HEARTS including the Ace ->
  // declares HEARTS by playing its lowest HEART (becomes trump).
  const lead = S[0];
  const hand = handOf(
    card(S[1], 7), card(S[1], 9), card(S[1], 11), card(S[1], 14), // 4 HEARTS w/ Ace
    card(S[2], 8), card(S[3], 8),
  );
  const trick = trickOf(lead, [played(1, card(lead, 9), 0)]); // someone led a spade
  const pick = call(hand, trick, { seat: 0 }); // no trump yet
  assert.equal(pick.suit, S[1], "declares the strong suit (HEARTS)");
  assert.equal(pick.rank, 7, "plays the lowest of the declared suit");
});

test("T-2 Decline: can't follow + no strong suit -> lowest of weakest suit", () => {
  // No SPADES (can't follow). No suit has >=4 cards with an A/K. Should fall to
  // the weakest-suit fallback. We assert the pick is a valid hand card and is
  // tied for the lowest rank present (lock-in; tie-break among weak suits is
  // unspecified by the spec).
  const lead = S[0];
  const hand = handOf(
    card(S[1], 7), card(S[2], 8), card(S[3], 9), // short, faceless suits
    card(S[2], 7),
  );
  const trick = trickOf(lead, [played(1, card(lead, 9), 0)]);
  const pick = call(hand, trick, { seat: 0 });
  assert.ok(hand.some((c) => c.id === pick.id), "pick is a card from the hand");
  const minRank = Math.min(...hand.map((c) => c.rank));
  assert.equal(pick.rank, minRank, "declines with the lowest card available");
});

// ---------- Cannot follow, trump established ----------
// The next two cover the "trump already set, can't follow suit" branch.

test("Save trumps: opp not threatening -> discard lowest non-trump", () => {
  // Trump = HEARTS, lead = SPADES, bot has no SPADES. Opponent winning a low
  // non-point trick -> bot should preserve trumps and dump its lowest non-trump.
  const lead = S[0];
  const hand = handOf(card(S[1], 14), card(S[2], 7), card(S[2], 9), card(S[3], 8));
  const trick = trickOf(lead, [played(1, card(lead, 11), 0)]); // opp J♠, no 10
  const pick = call(hand, trick, { seat: 0, trump: S[1] });
  assert.notEqual(pick.suit, S[1], "does NOT waste a trump");
  assert.equal(pick.rank, 7, "discards the lowest non-trump");
});

test("CHARACTERIZATION: endgame secure (myScore>=12) dumps highest trump", () => {
  // NOTE: the spec (§4) defines NO endgame/desperation heuristic. This test
  // locks in a behavior the code invents: at score >= 12 and unable to follow,
  // it plays its HIGHEST trump. We record it so a future change is noticed,
  // but this is NOT a spec rule. (If the spec is later followed strictly, this
  // branch should be removed and this test deleted/updated.)
  const lead = S[0];
  const hand = handOf(card(S[1], 14), card(S[1], 9), card(S[2], 7));
  const trick = trickOf(lead, [played(1, card(lead, 11), 0)]);
  const pick = call(hand, trick, { seat: 0, trump: S[1], scoreA: 12, scoreB: 5 });
  assert.equal(pick.suit, S[1], "endgame: plays a trump");
  assert.equal(pick.rank, 14, "endgame: the HIGHEST trump (non-spec lock-in)");
});

// ---------- Guard ----------

test("empty hand throws", () => {
  assert.throws(() => call([], trickOf("", [])), /empty hand/);
});
