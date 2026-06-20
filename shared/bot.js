// Mega Mindikot 5v5 — bot engine (master spec §4 heuristics, v1.3.0 numbering)
// Pure function of game snapshot. Imported by server.

import { resolveTrickWinner, SUITS } from "./rules.js";

// selectBotPlayCard(hand, trick, seatIndex, trumpSuit, seats, scoreA, scoreB)
//   trick: { leadSuit, playedCards: [{seat, card, playOrder}] }
//   seats: array indexed 0..9 -> { team }
//   returns a card from hand
export function selectBotPlayCard(hand, trick, seatIndex, trumpSuit, seats, scoreA, scoreB) {
  if (!hand.length) throw new Error("empty hand");
  const me = seats[seatIndex];
  const myTeam = me.team;
  const opponentTeam = myTeam === "A" ? "B" : "A";
  const myScore = myTeam === "A" ? scoreA : scoreB;
  const oppScore = opponentTeam === "A" ? scoreA : scoreB;

  const leadSuit = trick.leadSuit;
  const isLead = trick.playedCards.length === 0 || !leadSuit;
  const tensInTrick = trick.playedCards.some((p) => p.card.rank === 10);

  // --- LEAD heuristics (§4.1) ---
  if (isLead) {
    // L-1 Bleed Trumps: established trump + hold A/K of trump
    if (trumpSuit) {
      const high = hand.filter((c) => c.suit === trumpSuit && (c.rank === 14 || c.rank === 13));
      if (high.length) return high.sort(descRank)[0];
    }
    // L-2 Bait Trump: no trump + long suit (>=5) -> lead low (7/8)
    if (!trumpSuit) {
      for (const s of SUITS) {
        if (countSuit(hand, s) >= 5) {
          const low = hand.filter((c) => c.suit === s && (c.rank === 7 || c.rank === 8));
          if (low.length) return low.sort(ascRank)[0];
        }
      }
    }
    // L-3 Lead Aces/high of non-trump
    const aces = hand.filter((c) => c.suit !== trumpSuit && c.rank === 14);
    if (aces.length) return aces[0];
    const kings = hand.filter((c) => c.suit !== trumpSuit && c.rank === 13);
    if (kings.length) return kings[0];
    // L-4 Discard/weak lead: lowest of weakest suit
    const weak = weakestSuit(hand, trumpSuit);
    const weakCards = hand.filter((c) => c.suit === weak);
    if (weakCards.length) return weakCards.sort(ascRank)[0];
    return hand.slice().sort(ascRank)[0];
  }

  // --- FOLLOW / OFF-SUIT heuristics ---
  const leadCards = hand.filter((c) => c.suit === leadSuit);
  const cur = resolveTrickWinner(trick.playedCards, leadSuit, trumpSuit);
  const winnerSeat = cur.seat;
  const teammateWinning = seats[winnerSeat] && seats[winnerSeat].team === myTeam;

  if (leadCards.length) {
    // Can follow suit
    const sorted = leadCards.slice().sort(ascRank);
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];

    if (teammateWinning) {
      // F-2 Discard 10s if teammate guaranteed to win
      const wc = cur.card;
      const guaranteed =
        wc.rank === 14 && (wc.suit === trumpSuit || (!trumpSuit && wc.suit === leadSuit)) &&
        trick.playedCards.length >= 7; // late in order (spec F-2 playOrder>=7)
      if (guaranteed) {
        const ten = leadCards.find((c) => c.rank === 10);
        if (ten) return ten;
      }
      // F-1 Save power: lowest of lead suit
      return lowest;
    } else {
      // F-3 Beat opponent
      const oppTrump = trumpSuit && cur.card.suit === trumpSuit;
      if (oppTrump) return lowest; // can't beat a trump while following lead suit
      const winners = leadCards.filter((c) => c.rank > cur.card.rank).sort(ascRank);
      if (winners.length) {
        if (tensInTrick || highest.rank === 10) return winners[0]; // lowest that beats, if a point
        return lowest; // concede low-value trick
      }
      return lowest;
    }
  }

  // --- CANNOT follow suit: trump declaration or discard ---
  // Secure victory: dump highest trump / highest card
  const endgameSecure = myScore >= 12;
  if (endgameSecure) {
    const trumps = hand.filter((c) => c.suit === trumpSuit);
    if (trumps.length) return trumps.sort(descRank)[0];
    return hand.slice().sort(descRank)[0];
  }

  if (trumpSuit) {
    // Trump already established
    const trumps = hand.filter((c) => c.suit === trumpSuit);
    // Intercept: opponent winning + (10 in trick or desperation) + hold trump
    const desperation = oppScore >= 10;
    if (!teammateWinning && (tensInTrick || desperation) && trumps.length) {
      const oppTrump = cur.card.suit === trumpSuit;
      if (oppTrump) {
        const beat = trumps.filter((c) => c.rank > cur.card.rank).sort(ascRank);
        if (beat.length) return beat[0];
      } else {
        return trumps.sort(ascRank)[0]; // lowest trump beats any lead-suit card
      }
    }
    // Save trumps: discard lowest non-trump
    const nonTrump = hand.filter((c) => c.suit !== trumpSuit).sort(ascRank);
    if (nonTrump.length) return nonTrump[0];
    return trumps.sort(ascRank)[0];
  }

  // Trump NOT established: declare (T-1 / T-2)
  // T-1 Declare Strong Suit: >=4 cards with an A or K
  for (const s of SUITS) {
    if (countSuit(hand, s) >= 4 && hand.some((c) => c.suit === s && (c.rank === 14 || c.rank === 13))) {
      return hand.filter((c) => c.suit === s).sort(ascRank)[0];
    }
  }
  // T-2 Decline: lowest of weakest suit (establishes weak trump as last resort)
  const weak = weakestSuit(hand, "");
  const weakCards = hand.filter((c) => c.suit === weak);
  if (weakCards.length) return weakCards.sort(ascRank)[0];
  return hand.slice().sort(ascRank)[0];
}

function countSuit(hand, s) { return hand.reduce((n, c) => n + (c.suit === s ? 1 : 0), 0); }
function weakestSuit(hand, trumpSuit) {
  const counts = {};
  for (const c of hand) counts[c.suit] = (counts[c.suit] || 0) + 1;
  let best = null, min = Infinity;
  for (const s of SUITS) {
    if (s === trumpSuit) continue;
    if ((counts[s] || 0) > 0 && counts[s] < min) { min = counts[s]; best = s; }
  }
  if (best) return best;
  // only trumps left
  for (const s of SUITS) if (counts[s]) return s;
  return SUITS[0];
}
const ascRank = (a, b) => a.rank - b.rank;
const descRank = (a, b) => b.rank - a.rank;
