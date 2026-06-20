// Mega Mindikot 5v5 — authoritative rules engine (master spec v1.3.0)
// Pure, dependency-free, fully unit-testable. Imported by server.

export const SUITS = ["SPADES", "HEARTS", "DIAMONDS", "CLUBS"];
export const SUIT_GLYPH = { SPADES: "♠", HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣" };
export const SUIT_COLOR = { SPADES: "black", HEARTS: "red", DIAMONDS: "red", CLUBS: "black" };

// Authoritative rank scale (spec §2.1): 7..10 numeric, 11=J, 12=Q, 13=K, 14=A.
export const RANK_NAME = { 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
export const RANKS = [7, 8, 9, 10, 11, 12, 13, 14];
export const TEAMS = ["A", "B"];

// --- Constants from the spec ---
export const DECKS = 6;
export const DECK_SIZE = 192;          // 32 cards × 6 decks (spec §2.1)
export const PLAYERS = 10;             // 5v5
export const HAND_SIZE = 18;           // 18 × 10 = 180 dealt
export const KITTY_SIZE = 12;          // 192 − 180
export const KITTY_TRICKS = 12;        // kitty revealed over first 12 tricks
export const TRICKS = 18;              // 18 cards/player
export const TOTAL_TENS = 24;          // 4 suits × 6 decks
export const WIN_TENS = 13;            // immediate win threshold (spec §2.8)

export function teamForSeat(seatIndex) {
  return seatIndex % 2 === 0 ? "A" : "B"; // spec §2.10
}
export function isAce(card) { return card.rank === 14; }
export function isTen(card) { return card.rank === 10; }

// Build the 192-card composite deck. 6 decks × (8 ranks × 4 suits) = 192.
// Each card gets a globally unique id encoding deck#, suit, rank.
export function buildDeck() {
  const deck = [];
  for (let d = 0; d < DECKS; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `c_${d}_${suit}_${rank}`, suit, rank });
      }
    }
  }
  return deck; // length === 192
}

// Fisher–Yates shuffle returning a new array.
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deal 18 cards to each of 10 players + 12 kitty. Returns {hands: [...10], kitty: [...12]}.
export function dealHands(deck) {
  if (deck.length !== DECK_SIZE) throw new Error(`Bad deck size ${deck.length}`);
  const hands = Array.from({ length: PLAYERS }, () => []);
  for (let i = 0; i < HAND_SIZE * PLAYERS; i++) hands[i % PLAYERS].push(deck[i]);
  const kitty = deck.slice(HAND_SIZE * PLAYERS); // last 12
  return { hands, kitty };
}

// Validate that a card play is legal (follow-suit rule, spec §2.5).
// Returns true if legal; the off-suit info drives trump establishment.
export function validatePlay(card, hand, leadSuit) {
  if (!hand.some((c) => c.id === card.id)) return false;
  if (leadSuit && card.suit !== leadSuit) {
    return !hand.some((c) => c.suit === leadSuit); // illegal if holding lead suit
  }
  return true;
}

// Given a completed trick's played cards, resolve the winner (spec §2.7).
// playedCards: [{seat, card, playOrder}]. Returns winning playOrder index / seat.
export function resolveTrickWinner(playedCards, leadSuit, trumpSuit) {
  if (!playedCards.length) throw new Error("empty trick");

  const candidates = trumpSuit
    ? playedCards.filter((p) => p.card.suit === trumpSuit)
    : playedCards.filter((p) => p.card.suit === leadSuit);
  // Discards (neither lead nor trump) are ineligible to win (spec §2.7.3).
  const pool = candidates.length ? candidates : playedCards.filter((p) => p.card.suit === leadSuit);
  const final = pool.length ? pool : playedCards;

  let maxRank = -1;
  for (const p of final) if (p.card.rank > maxRank) maxRank = p.card.rank;
  const top = final.filter((p) => p.card.rank === maxRank);

  // "Last Identical Wins": highest playOrder among the tied top cards.
  let winner = top[0];
  for (let i = 1; i < top.length; i++) if (top[i].playOrder > winner.playOrder) winner = top[i];
  return winner;
}

// Count tens in a list of cards.
export function countTens(cards) {
  return cards.reduce((n, c) => n + (isTen(c) ? 1 : 0), 0);
}

// Auto-play picker for AFK / timeout (spec §2.9). Returns a card from hand.
export function autoPlayPick(hand, leadSuit, trumpSuit) {
  if (!hand.length) throw new Error("empty hand");
  if (leadSuit) {
    const lead = hand.filter((c) => c.suit === leadSuit).sort(byRankAsc);
    if (lead.length) return lead[0]; // (1) lowest lead-suit card
  }
  const nonTrump = hand.filter((c) => c.suit !== trumpSuit).sort(byRankAsc);
  if (trumpSuit && nonTrump.length) return nonTrump[0]; // (2) lowest non-trump
  if (!trumpSuit) {
    // (3) lowest of suit held most of (minimize accidental trump declaration)
    const counts = {};
    for (const c of hand) counts[c.suit] = (counts[c.suit] || 0) + 1;
    let best = hand[0].suit, bestN = -1;
    for (const s of SUITS) if ((counts[s] || 0) > bestN) { bestN = counts[s]; best = s; }
    return hand.filter((c) => c.suit === best).sort(byRankAsc)[0];
  }
  return hand.slice().sort(byRankAsc)[0];
}

const byRankAsc = (a, b) => a.rank - b.rank;
