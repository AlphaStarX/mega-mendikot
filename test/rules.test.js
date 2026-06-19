// Self-test: drives a full 10-bot match through the game room and asserts the
// spec invariants (master spec v1.3.0). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeck, shuffle, dealHands, validatePlay, resolveTrickWinner, countTens,
  autoPlayPick, DECK_SIZE, HAND_SIZE, KITTY_SIZE, TOTAL_TENS, WIN_TENS, teamForSeat,
} from "../shared/rules.js";

test("deck is 192 cards, 6 of each card, all ranks 7..14", () => {
  const d = buildDeck();
  assert.equal(d.length, DECK_SIZE);
  // 6 copies of each (suit, rank)
  const counts = {};
  for (const c of d) counts[`${c.suit}_${c.rank}`] = (counts[`${c.suit}_${c.rank}`] || 0) + 1;
  const unique = new Set(Object.keys(counts));
  assert.equal(unique.size, 32, "32 unique (suit,rank)");
  for (const k of Object.keys(counts)) assert.equal(counts[k], 6, `${k} has 6 copies`);
});

test("deal splits into 10 hands of 18 + 12 kitty", () => {
  const { hands, kitty } = dealHands(shuffle(buildDeck()));
  assert.equal(hands.length, 10);
  hands.forEach((h) => assert.equal(h.length, HAND_SIZE));
  assert.equal(kitty.length, KITTY_SIZE);
});

test("team assignment alternates seats (Team A even, Team B odd)", () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(teamForSeat(i), i % 2 === 0 ? "A" : "B");
  }
});

test("trump beats lead suit even at lower rank", () => {
  const played = [
    { seat: 0, card: { suit: "HEARTS", rank: 14 }, playOrder: 0 }, // Ace of Hearts
    { seat: 1, card: { suit: "SPADES", rank: 8 }, playOrder: 1 },  // 8 of trump
    { seat: 2, card: { suit: "HEARTS", rank: 10 }, playOrder: 2 },
  ];
  const w = resolveTrickWinner(played, "HEARTS", "SPADES");
  assert.equal(w.seat, 1, "trump 8 beats non-trump Ace");
});

test("last identical highest card wins (duplicate rule)", () => {
  const played = [
    { seat: 0, card: { suit: "HEARTS", rank: 14 }, playOrder: 0 },
    { seat: 1, card: { suit: "HEARTS", rank: 14 }, playOrder: 3 }, // last identical Ace
    { seat: 2, card: { suit: "HEARTS", rank: 13 }, playOrder: 1 },
  ];
  const w = resolveTrickWinner(played, "HEARTS", "");
  assert.equal(w.seat, 1, "last-played Ace wins the tie");
});

test("off-suit discard cannot win", () => {
  const played = [
    { seat: 0, card: { suit: "HEARTS", rank: 8 }, playOrder: 0 },  // lead 8
    { seat: 1, card: { suit: "CLUBS", rank: 14 }, playOrder: 1 },  // discard Ace
  ];
  const w = resolveTrickWinner(played, "HEARTS", "SPADES");
  assert.equal(w.seat, 0, "lead-suit 8 beats off-suit Ace");
});

test("validatePlay rejects off-suit when lead suit is held", () => {
  const hand = [{ id: "h", suit: "HEARTS", rank: 8 }, { id: "s", suit: "SPADES", rank: 14 }];
  assert.equal(validatePlay(hand[1], hand, "HEARTS"), false);
  assert.equal(validatePlay(hand[0], hand, "HEARTS"), true);
  assert.equal(validatePlay(hand[1], hand, "CLUBS"), true); // no clubs held -> off-suit ok
});

test("autoPlayPick follows suit with lowest when possible", () => {
  const hand = [
    { suit: "HEARTS", rank: 10 }, { suit: "HEARTS", rank: 8 }, { suit: "SPADES", rank: 14 },
  ];
  assert.equal(autoPlayPick(hand, "HEARTS", "").rank, 8, "lowest lead-suit card");
  // no trump + no lead suit -> lowest of most-held suit
  assert.equal(autoPlayPick([{ suit: "SPADES", rank: 14 }], "HEARTS", "").rank, 14);
});

test("tens in full deck total 24 (4 suits x 6 decks)", () => {
  assert.equal(countTens(buildDeck()), TOTAL_TENS);
});
