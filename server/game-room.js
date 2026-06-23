// Mega Mindikot 5v5 — authoritative game room (master spec v1.3.0 + v1.3.1
// deadlock rule change: most-tricks-won tiebreak instead of last trick)
// Multi-human: up to 10 humans per room, bots fill empty seats.
// Owns the full match lifecycle: matchmaking, dealing, kitty, turn timer,
// trump establishment, trick resolution, bot fill, win/deadlock, reconnection.

import {
  PLAYERS, HAND_SIZE, TRICKS, KITTY_SIZE, KITTY_TRICKS, WIN_TENS, TOTAL_TENS,
  buildDeck, shuffle, dealHands, validatePlay, resolveTrickWinner, countTens,
  autoPlayPick, teamForSeat, isTen, resolveDeadlock,
} from "../shared/rules.js";
import { selectBotPlayCard } from "../shared/bot.js";
import { makeLiveKitToken, voiceConfigured, voiceConfig, voiceRoomName } from "./livekit.js";

export const TURN_SECONDS = 20;     // spec §2.9
const BOT_DELAY_MIN_MS = 1500;      // bots "think" before playing
const BOT_DELAY_MAX_MS = 3200;
const RESOLVE_DELAY_MS = 2600;      // let client animate trick capture + kitty flip
const LEAD_CARD_DEAL_MS = 1300;     // stagger between lead-selection cards flipping (matches client; ~13s for 10 cards)
const LEAD_PAUSE_MS = 2500;         // pause after the last card flips before resolving the round
const LEAD_WINNER_MS = 3500;        // hold the winner highlight so players can read who led before dealing
const RECONNECT_GRACE_MS = 60000;   // spec §4.4

// Build the table seating: 10 alternating seats, teams A/B per §2.2/§2.10.
function makeSeats() {
  return Array.from({ length: PLAYERS }, (_, i) => ({
    seat: i,
    team: teamForSeat(i),
    isBot: true,
    isHuman: false,
    sessionId: null,
    name: `Bot ${i + 1}`,
    hand: [],
    cardsLeft: 0,
    isConnected: true,
    isAfk: false,
    timeouts: 0,
    tens: 0,
    ready: false,
    disconnectAt: null,
  }));
}

export class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.seats = makeSeats();
    this.sockets = {};           // seatIndex -> ws (only connected humans)
    this.hostSeat = null;        // first human to join is the host
    this.privateRoom = false;    // private rooms wait for host to start

    this.matchState = "LOBBY";    // LOBBY|DEALING|PLAYING|FINISHED
    this.hands = null;            // [...10 hands]
    this.kitty = [];              // 12 kitty cards
    this.kittyIdx = 0;            // next kitty card to place

    this.trickNumber = 1;
    this.leadSuit = "";
    this.trumpSuit = "";
    this.trumpDeclarerSeat = null;
    this.playedCards = [];        // current trick
    this.activeSeat = -1;
    this.leadSeat = -1;
    // Lead-selection ceremony state (spec §2.4, made visible). A separate
    // shuffled deck deals one card per seat; tied seats redraw until unique.
    this.leadSelectDeck = [];     // remaining selection cards
    this.leadSelectCards = {};    // seat -> { card, round } (current visible card per seat)
    this.leadSelectRound = 0;     // current shootout round (1-based)
    this.leadSelectTimer = null;  // staged-ceremony timer handle
    this.lastTrickWinnerTeam = null; // team that won the most recent trick
    this.tricksWon = { A: 0, B: 0 }; // tricks captured per team (deadlock tiebreak)

    this.score = { A: 0, B: 0 };
    // Per-team per-suit captured-Tens history, for the on-screen chip tracker.
    // Each entry is { suit }. Used by sendInitTo (reconnect) + trickWon (live).
    this.capturedTens = { A: [], B: [] };
    this.turnTime = TURN_SECONDS;
    this.tickHandle = null;
    this.botHandle = null;
    this.resolveHandle = null;
    this.graceHandles = {};       // seatIndex -> grace timer

    this.log = [];
  }

  // --- human seat management ---
  humanCount() {
    return this.seats.filter((s) => s.isHuman && s.isConnected).length;
  }

  // Pick the next open seat, preferring to balance teams, then lowest index.
  nextOpenSeat() {
    const teamCounts = { A: 0, B: 0 };
    for (const s of this.seats) if (s.isHuman) teamCounts[s.team]++;
    // Prefer the team with fewer humans; among that team, lowest seat index that's a bot.
    const weakerTeam = teamCounts.A <= teamCounts.B ? "A" : "B";
    for (const s of this.seats) {
      if (s.isBot && s.team === weakerTeam) return s.seat;
    }
    // Fallback: any open bot seat
    for (const s of this.seats) if (s.isBot) return s.seat;
    return -1;
  }

  // Add a human to an open seat. Returns seat index or -1 if full / already seated.
  addHuman(ws, sessionId, name) {
    // Reconnection: if this sessionId already owns a seat, reclaim it.
    const existing = this.seats.find((s) => s.isHuman && s.sessionId === sessionId);
    if (existing) {
      return this.onHumanReconnect(ws, sessionId);
    }
    if (this.humanCount() >= PLAYERS) return -1; // room full
    const seatIdx = this.nextOpenSeat();
    if (seatIdx === -1) return -1;
    const seat = this.seats[seatIdx];
    seat.isBot = false;
    seat.isHuman = true;
    seat.sessionId = sessionId;
    seat.name = name || `Player ${seatIdx + 1}`;
    seat.isConnected = true;
    seat.ready = false;
    seat.isAfk = false;
    seat.timeouts = 0;
    this.sockets[seatIdx] = ws;
    if (this.hostSeat === null) this.hostSeat = seatIdx;
    this.log.push(`Human joined seat ${seatIdx} (${seat.name})`);
    return seatIdx;
  }

  // Let a human move to (or claim) a specific open bot seat. Only valid in
  // LOBBY. The target must currently be a bot — this both lets an unseated
  // human claim their first seat AND lets a seated human switch seats. Switching
  // reverts the old seat to a bot. Because only 5 seats exist per team, you can't
  // join a team that already has 5 humans (all its seats are human, none are bot).
  // `ws` is the player's socket; if the mover is the host, the hostSeat follows
  // them to the new seat. Returns the new seat index, or -1 on rejection.
  chooseSeat(targetIdx, sessionId, name, ws) {
    if (this.matchState !== "LOBBY") return -1;
    if (targetIdx < 0 || targetIdx >= PLAYERS) return -1;
    const target = this.seats[targetIdx];
    if (!target || !target.isBot) return -1; // can't take an occupied seat
    // Find the seat this human currently owns (if any) so we can vacate it.
    const oldIdx = this.seats.findIndex((s) => s.isHuman && s.sessionId === sessionId);
    // Take the target seat (same field set as addHuman).
    target.isBot = false;
    target.isHuman = true;
    target.sessionId = sessionId;
    target.name = name || `Player ${targetIdx + 1}`;
    target.isConnected = true;
    target.ready = false;
    target.isAfk = false;
    target.timeouts = 0;
    this.sockets[targetIdx] = ws;
    // If the human was seated elsewhere, revert the old seat to a bot.
    if (oldIdx !== -1 && oldIdx !== targetIdx) {
      const old = this.seats[oldIdx];
      old.isBot = true;
      old.isHuman = false;
      old.sessionId = null;
      old.name = `Bot ${oldIdx + 1}`;
      old.hand = [];
      old.cardsLeft = 0;
      old.tens = 0;
      old.ready = false;
      old.isConnected = true;
      old.isAfk = false;
      old.timeouts = 0;
      old.disconnectAt = null;
      delete this.sockets[oldIdx];
      // First joiner is always host; if the host moved, the crown follows.
      if (this.hostSeat === oldIdx) this.hostSeat = targetIdx;
    } else if (this.hostSeat === null) {
      this.hostSeat = targetIdx;
    }
    this.log.push(`Human chose seat ${targetIdx} (${target.name}).`);
    return targetIdx;
  }

  setReady(seatIdx, ready) {
    if (this.seats[seatIdx]) this.seats[seatIdx].ready = !!ready;
  }

  start() {
    if (this.matchState !== "LOBBY") return false;
    // Lead-selection ceremony FIRST (spec §2.4, now visible). We deal one card
    // per seat from a SEPARATE shuffled deck; the unique-highest becomes lead.
    // Tied seats redraw in shootout rounds. Real hand is dealt only after.
    this.matchState = "LEAD_SELECT";
    this.leadSelectDeck = shuffle(buildDeck()); // separate from the play deck
    this.leadSelectCards = {};
    this.leadSelectRound = 0;
    this.log.push("Match starting: lead-selection ceremony.");
    // Tell clients to show the game table (empty) for the ceremony.
    for (const s of this.seats) if (s.isHuman) this.sendLeadSelectEnter(s.seat);
    // Kick off round 1 after a brief beat so the table can render.
    this.leadSelectTimer = setTimeout(() => this.runLeadSelectRound(), 400);
    return true;
  }

  // Deal one selection card to each ACTIVE seat for this round, broadcast the
  // face-up cards (staggered), then schedule resolution.
  runLeadSelectRound(activeSeats = null) {
    this.leadSelectRound++;
    // Round 1 = all 10 seats; shootout rounds = only the previously-tied seats.
    const seats = activeSeats || Array.from({ length: PLAYERS }, (_, i) => i);
    const cards = [];
    for (const seat of seats) {
      const card = this.leadSelectDeck.pop() || { suit: "SPADES", rank: 7 };
      this.leadSelectCards[seat] = { card, round: this.leadSelectRound };
      cards.push({ seat, card: this.cardView(card) });
    }
    const totalSeats = Object.keys(this.leadSelectCards).length;
    this.broadcast({
      t: "leadSelect",
      round: this.leadSelectRound,
      activeSeats: seats,
      cards,
      // send ALL currently-visible cards so the client can dim the eliminated ones
      allCards: Object.entries(this.leadSelectCards).map(([seat, c]) => ({ seat: +seat, card: this.cardView(c.card) })),
      totalSeats,
    });
    const stagger = cards.length * LEAD_CARD_DEAL_MS;
    this.leadSelectTimer = setTimeout(() => this.resolveLeadSelect(seats), LEAD_PAUSE_MS + stagger);
  }

  // Determine the round's unique max rank. If one seat holds it -> lead decided.
  // If multiple tie -> run another shootout round with only the tied seats.
  resolveLeadSelect(activeSeats) {
    let maxRank = -1;
    for (const seat of activeSeats) {
      const c = this.leadSelectCards[seat];
      if (c && c.card.rank > maxRank) maxRank = c.card.rank;
    }
    const tied = activeSeats.filter((seat) => this.leadSelectCards[seat].card.rank === maxRank);
    if (tied.length === 1) {
      // Unique winner — announce, then deal the real hand.
      const winner = tied[0];
      const wc = this.leadSelectCards[winner].card;
      this.leadSeat = winner;
      this.broadcast({ t: "leadSelect", winner, winnerCard: this.cardView(wc), round: this.leadSelectRound });
      this.log.push(`Lead selection: seat ${winner} wins round ${this.leadSelectRound} with rank ${wc.rank}.`);
      this.leadSelectTimer = setTimeout(() => this.dealRealHand(), LEAD_WINNER_MS);
    } else {
      // Shootout: only the tied seats redraw next round.
      this.log.push(`Lead selection round ${this.leadSelectRound}: ${tied.length}-way tie at rank ${maxRank}; shootout.`);
      this.leadSelectTimer = setTimeout(() => this.runLeadSelectRound(tied), 350);
    }
  }

  // After the ceremony resolves: build + deal the real 192-card hand, start play.
  dealRealHand() {
    this.leadSelectTimer = null;
    this.matchState = "DEALING";
    this.log.push("Lead-selection complete; dealing 192-card deck.");

    const deck = shuffle(buildDeck());
    const { hands, kitty } = dealHands(deck);
    this.hands = hands;
    this.kitty = kitty;
    for (let i = 0; i < PLAYERS; i++) {
      this.seats[i].hand = hands[i];
      this.seats[i].cardsLeft = HAND_SIZE;
    }
    this.activeSeat = this.leadSeat;
    this.matchState = "PLAYING";
    this.log.push(`Trick 1 lead: seat ${this.leadSeat}.`);

    // Send each human their personalized view (fog of war — §3.4)
    for (const s of this.seats) if (s.isHuman) this.sendInitTo(s.seat);
    this.startTurnTimer();
    this.maybeScheduleBot();
  }

  // Minimal nudge so a human client shows the game table for the ceremony.
  sendLeadSelectEnter(seatIdx) {
    const ws = this.sockets[seatIdx];
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: "leadSelectEnter", seats: this.seats.map((s) => ({ seat: s.seat, name: s.name, team: s.team, isBot: s.isBot })), you: seatIdx, _ts: Date.now() }));
  }

  // --- turn timer (spec §2.9) ---
  startTurnTimer() {
    this.stopTurnTimer();
    this.turnTime = TURN_SECONDS;
    this.tickHandle = setInterval(() => this.tick(), 1000);
  }
  stopTurnTimer() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }
  tick() {
    if (this.matchState !== "PLAYING") return;
    this.turnTime--;
    if (this.turnTime === 5) this.broadcast({ t: "turnWarning", seat: this.activeSeat });
    if (this.turnTime <= 0) {
      this.log.push(`Time expired for seat ${this.activeSeat} — auto-play.`);
      this.handleTimeout();
    }
  }

  handleTimeout() {
    const seat = this.seats[this.activeSeat];
    seat.timeouts++;
    if (seat.timeouts >= 2) seat.isAfk = true;
    const card = autoPlayPick(seat.hand, this.leadSuit, this.trumpSuit);
    this.playCard(this.activeSeat, card.id, /*auto=*/true);
  }

  maybeScheduleBot() {
    this.clearBot();
    const seat = this.seats[this.activeSeat];
    if (!seat || seat.isBot || (seat.isHuman && !seat.isConnected) || seat.isAfk) {
      // Bot turn, or human is disconnected/AFK -> takeover
      const delay = seat.isHuman
        ? BOT_DELAY_MIN_MS
        : Math.floor(BOT_DELAY_MIN_MS + Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS));
      this.broadcast({ t: "botThinking", seat: this.activeSeat });
      this.botHandle = setTimeout(() => this.botPlay(), delay);
    }
  }
  clearBot() { if (this.botHandle) { clearTimeout(this.botHandle); this.botHandle = null; } }

  botPlay() {
    if (this.matchState !== "PLAYING") return;
    const seatIdx = this.activeSeat;
    const seat = this.seats[seatIdx];
    if (!seat.hand.length) return;
    const trick = { leadSuit: this.leadSuit, playedCards: this.playedCards };
    const seatsView = this.seats.map((s) => ({ team: s.team }));
    const card = selectBotPlayCard(
      seat.hand, trick, seatIdx, this.trumpSuit, seatsView, this.score.A, this.score.B
    );
    this.playCard(seatIdx, card.id, /*auto=*/true);
  }

  // --- human action entry (multi-human: resolved by seat) ---
  onPlayCardFromSeat(seatIdx, cardId) {
    if (this.matchState !== "PLAYING") return this.sendErrorTo(seatIdx, "Match not in play.");
    if (this.activeSeat !== seatIdx) return this.sendErrorTo(seatIdx, "Not your turn.");
    const seat = this.seats[seatIdx];
    const card = seat.hand.find((c) => c.id === cardId);
    if (!card) return this.sendErrorTo(seatIdx, "Card not in your hand.");
    if (!validatePlay(card, seat.hand, this.leadSuit)) {
      return this.sendErrorTo(seatIdx, `You must follow the lead suit (${this.leadSuit}).`);
    }
    seat.timeouts = 0; // manual play clears AFK path
    if (seat.isAfk) { seat.isAfk = false; seat.timeouts = 0; }
    this.clearBot();
    this.playCard(seatIdx, cardId, /*auto=*/false);
  }

  // --- team chat (spec §1.2: team-only text chat) ---
  onChatFromSeat(seatIdx, text) {
    if (this.matchState !== "PLAYING") return;
    const seat = this.seats[seatIdx];
    if (!seat) return;
    // Sanitize: trim, cap at 200 chars, escape HTML to prevent injection.
    const clean = String(text || "").trim().slice(0, 200)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    if (!clean) return;
    // Sender identity comes from the server, never the client (prevents spoofing).
    this.broadcastToTeam(seat.team, {
      t: "chat", seat: seatIdx, name: seat.name, team: seat.team, text: clean,
    });
    this.log.push(`Chat [${seat.team}] ${seat.name}: ${clean}`);
  }
  playCard(seatIdx, cardId, auto) {
    const seat = this.seats[seatIdx];
    const idx = seat.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return;
    const card = seat.hand.splice(idx, 1)[0];
    seat.cardsLeft = seat.hand.length;
    const played = { seat: seatIdx, card, playOrder: this.playedCards.length };
    this.playedCards.push(played);

    // Establish lead suit on first play of trick
    if (this.playedCards.length === 1) this.leadSuit = card.suit;

    // Establish trump (spec §2.6): first legal off-suit sets trump permanently
    if (!this.trumpSuit && this.leadSuit && card.suit !== this.leadSuit) {
      this.trumpSuit = card.suit;
      this.trumpDeclarerSeat = seatIdx;
      this.log.push(`Trump established: ${this.trumpSuit} by seat ${seatIdx}.`);
      this.broadcast({ t: "trumpDeclared", suit: this.trumpSuit, seat: seatIdx });
    }

    this.broadcast({ t: "played", seat: seatIdx, card: this.cardView(card), playOrder: played.playOrder, auto });

    if (this.playedCards.length < PLAYERS) {
      this.activeSeat = (this.activeSeat + 1) % PLAYERS;
      this.turnTime = TURN_SECONDS;
      this.maybeScheduleBot();
    } else {
      this.resolveTrick();
    }
  }

  // --- resolve completed trick (spec §2.7, §2.3 kitty, §2.8 win/deadlock) ---
  resolveTrick() {
    this.stopTurnTimer();
    this.clearBot();
    this.activeSeat = -1; // block plays during resolution animation

    const winner = resolveTrickWinner(this.playedCards, this.leadSuit, this.trumpSuit);
    const winSeat = winner.seat;
    const winTeam = this.seats[winSeat].team;
    this.lastTrickWinnerTeam = winTeam;
    this.tricksWon[winTeam]++;   // tracked for the 12-12 deadlock tiebreak

    // Tens captured from played cards
    let tens = countTens(this.playedCards.map((p) => p.card));
    this.seats[winSeat].tens += tens;
    // Per-suit capture log for the on-screen chip tracker.
    for (const p of this.playedCards) {
      if (isTen(p.card)) this.capturedTens[winTeam].push({ suit: p.card.suit });
    }

    // Kitty reveal over first 12 tricks (spec §2.3)
    let kittyCard = null, kittyTen = 0;
    if (this.trickNumber <= KITTY_TRICKS && this.kittyIdx < this.kitty.length) {
      kittyCard = this.kitty[this.kittyIdx++];
      if (isTen(kittyCard)) {
        kittyTen = 1;
        this.capturedTens[winTeam].push({ suit: kittyCard.suit });
      }
      tens += kittyTen;
      this.score[winTeam] += kittyTen;
      this.log.push(`Kitty reveal trick ${this.trickNumber}: ${this.cardView(kittyCard).label} -> team ${winTeam}.`);
    }
    this.score[winTeam] += tens - kittyTen; // played tens counted above under team only once

    this.broadcast({
      t: "trickWon",
      winnerSeat: winSeat,
      team: winTeam,
      tens,
      kittyCard: kittyCard ? this.cardView(kittyCard) : null,
      cards: this.playedCards.map((p) => ({ seat: p.seat, card: this.cardView(p.card) })),
      score: this.score,
      capturedTens: this.capturedTens,
      tricksWon: { ...this.tricksWon },
      trickNumber: this.trickNumber,
    });
    this.log.push(`Trick ${this.trickNumber} won by seat ${winSeat} (team ${winTeam}); +${tens} tens.`);

    // Immediate win check (§2.8) — kitty tens included
    if (this.score.A >= WIN_TENS || this.score.B >= WIN_TENS) {
      return this.endMatch(this.score.A >= WIN_TENS ? "A" : "B");
    }

    // All tricks played?
    if (this.trickNumber >= TRICKS) {
      // 12-12 deadlock (rule change, v1.3.1): most tricks won takes it; if
      // tricks are also tied, the match is a draw (endMatch(null)).
      if (this.score.A === this.score.B) {
        const dl = resolveDeadlock(this.tricksWon.A, this.tricksWon.B);
        this.log.push(`12-12 deadlock resolved by most tricks (A:${this.tricksWon.A} B:${this.tricksWon.B}) -> ${dl === null ? "DRAW" : "team " + dl}.`);
        return this.endMatch(dl);
      }
      return this.endMatch(this.score.A > this.score.B ? "A" : "B");
    }

    // Schedule next trick
    this.resolveHandle = setTimeout(() => {
      this.playedCards = [];
      this.leadSuit = "";
      this.trickNumber++;
      this.activeSeat = winSeat;
      this.leadSeat = winSeat;
      this.broadcast({
        t: "trickStart",
        trickNumber: this.trickNumber,
        leadSeat: winSeat,
        kittyActive: this.trickNumber <= KITTY_TRICKS && this.kittyIdx < this.kitty.length,
        kittyLeft: KITTY_SIZE - this.kittyIdx,
      });
      this.startTurnTimer();
      this.maybeScheduleBot();
    }, RESOLVE_DELAY_MS);
  }

  endMatch(winningTeam) {
    this.stopTurnTimer();
    this.clearBot();
    if (this.resolveHandle) { clearTimeout(this.resolveHandle); this.resolveHandle = null; }
    this.matchState = "FINISHED";
    // NOTE: voice is intentionally NOT torn down here. Voice persists from the
    // match through the end screen and into the post-match lobby ("Play Again"
    // party cohesion) — clients stay connected to the same `mm_{roomId}` room.
    // Voice is dropped only when a player explicitly Leaves (client closes the WS).
    // deadlock flag = the 12-12 tiebreak path was taken (score tied at match end).
    // Lets the client distinguish a normal 13-Ten win from a tricks-decided win.
    const deadlock = this.score.A === this.score.B;
    this.broadcast({
      t: "matchEnd",
      winningTeam,            // "A" | "B" | null (null = draw)
      draw: winningTeam === null,
      deadlock,               // true iff decided by the 12-12 tiebreak (win or draw)
      score: this.score,
      tricksWon: { ...this.tricksWon },
      seats: this.seats.map((s) => ({ name: s.name, seat: s.seat, team: s.team, tens: s.tens, isBot: s.isBot })),
    });
    if (winningTeam === null) {
      this.log.push(`Match ended in a DRAW. Final ${JSON.stringify(this.score)} tricks ${JSON.stringify(this.tricksWon)}.`);
    } else {
      this.log.push(`Match ended. Winner: team ${winningTeam}. Final ${JSON.stringify(this.score)}.`);
    }
  }

  // Return a FINISHED room to LOBBY for "Play Again": zero all match state but
  // keep humans seated (and bots as bots) so the party stays together. Triggered
  // by the host's playAgain message. Returns true if the reset happened.
  resetToLobby() {
    if (this.matchState !== "FINISHED") return false;
    // Zero match-wide state.
    this.score = { A: 0, B: 0 };
    this.tricksWon = { A: 0, B: 0 };
    this.capturedTens = { A: [], B: [] };
    this.trickNumber = 1;
    this.leadSuit = "";
    this.trumpSuit = "";
    this.trumpDeclarerSeat = null;
    this.playedCards = [];
    this.activeSeat = -1;
    this.leadSeat = -1;
    this.hands = null;
    this.kitty = [];
    this.kittyIdx = 0;
    // Clear lead-selection ceremony state.
    this.leadSelectDeck = [];
    this.leadSelectCards = {};
    this.leadSelectRound = 0;
    this.lastTrickWinnerTeam = null;
    // Reset per-seat match state for every seat, but keep identity (human/bot,
    // sessionId, name, connection) so the same players are seated for the next game.
    for (const seat of this.seats) {
      seat.hand = [];
      seat.cardsLeft = 0;
      seat.tens = 0;
      seat.ready = false;
    }
    this.matchState = "LOBBY";
    this.log.push("Match reset to LOBBY (Play Again).");
    // Re-sync all clients back to the lobby screen (this also re-mints voice tokens).
    this.broadcastLobby();
    return true;
  }

  // --- reconnection (spec §4.4) ---
  onHumanDisconnect(seatIdx) {
    const seat = this.seats[seatIdx];
    if (!seat || !seat.isHuman) return;
    seat.isConnected = false;
    seat.disconnectAt = Date.now();
    delete this.sockets[seatIdx];

    // If the host left, promote the lowest-numbered still-connected human so the
    // room always has a host who can Start / Play Again. Previously the host was
    // never reassigned, which stranded a room once the host disconnected.
    if (this.hostSeat === seatIdx) {
      const nextHost = this.seats.find((s) => s.isHuman && s.isConnected);
      this.hostSeat = nextHost ? nextHost.seat : null;
      if (nextHost) this.log.push(`Host left; promoted seat ${nextHost.seat} to host.`);
    }

    // Quick-match (non-private) rooms are throwaway: if no humans remain connected,
    // end the match immediately so the room gets cleaned up instead of playing out
    // a pointless all-bot game and lingering. Private rooms persist for friends.
    if (!this.privateRoom && this.matchState === "PLAYING" && this.humanCount() === 0) {
      this.log.push(`Last human left quick-match room; ending match early.`);
      const winner = this.score.A === this.score.B
        ? resolveDeadlock(this.tricksWon.A, this.tricksWon.B)  // tied -> most tricks, else draw
        : (this.score.A > this.score.B ? "A" : "B");
      this.clearBot();
      this.stopTurnTimer();
      this.endMatch(winner);   // may be null (draw) if both tens & tricks tied
      return;
    }

    if (this.matchState !== "PLAYING") return;
    if (this.activeSeat === seatIdx) this.maybeScheduleBot();
    // grace timer: after RECONNECT_GRACE_MS, seat stays bot-controlled (no penalty)
    if (this.graceHandles[seatIdx]) clearTimeout(this.graceHandles[seatIdx]);
    this.graceHandles[seatIdx] = setTimeout(() => {
      this.log.push(`Reconnection grace expired for seat ${seatIdx}.`);
      delete this.graceHandles[seatIdx];
    }, RECONNECT_GRACE_MS);
  }

  onHumanReconnect(ws, sessionId) {
    const seat = this.seats.find((s) => s.isHuman && s.sessionId === sessionId);
    if (!seat) return -1;
    const seatIdx = seat.seat;
    if (this.graceHandles[seatIdx]) { clearTimeout(this.graceHandles[seatIdx]); delete this.graceHandles[seatIdx]; }
    this.sockets[seatIdx] = ws;
    seat.isConnected = true;
    seat.isAfk = false;
    seat.timeouts = 0;
    seat.disconnectAt = null;
    this.log.push(`Human reconnected to seat ${seatIdx}; state re-synced.`);
    if (this.matchState === "PLAYING") {
      this.sendInitTo(seatIdx); // re-sync full state on reconnection
    }
    return seatIdx;
  }

  // --- lobby state broadcast (sent to all humans in the room) ---
  broadcastLobby() {
    // Tell each connected human their own seat first, so the client renders the
    // seat map with a reliable `state.you` (the old name-match heuristic was
    // fragile and couldn't show "You" correctly in the seat map).
    for (const seatIdx in this.sockets) {
      safeSend(this.sockets[seatIdx], { t: "yourSeat", seat: Number(seatIdx) });
    }
    const lobby = {
      t: "lobbyUpdate",
      room: this.roomId,
      hostSeat: this.hostSeat,
      matchState: this.matchState,
      privateRoom: this.privateRoom,
      seats: this.seats.map((s) => ({
        seat: s.seat, team: s.team, name: s.name, isBot: s.isBot,
        isConnected: s.isConnected, ready: s.ready,
      })),
    };
    this.broadcast(lobby);
    // Push a per-seat voice token to each connected human so they can opt into
    // lobby voice. Tokens are per-identity, so this can't ride on the shared
    // lobbyUpdate payload. No-op when voice isn't configured or the seat is a bot.
    if (voiceConfigured()) {
      for (const seatIdx in this.sockets) {
        const voice = this.voiceTokenForSeat(Number(seatIdx));
        if (voice) safeSend(this.sockets[seatIdx], { t: "lobbyVoice", ...voice });
      }
    }
  }

  // --- network helpers ---
  cardView(card) {
    return { id: card.id, suit: card.suit, rank: card.rank, label: cardLabel(card) };
  }

  // Mint a LiveKit access token for a connected human seat. All players in the
  // match (both teams) share one room (`mm_{roomId}`), so everyone can hear
  // each other. Returns null when voice isn't configured or the seat isn't a
  // connected human — callers must treat null as "no voice for this seat"
  // (graceful no-op).
  voiceTokenForSeat(seatIdx) {
    const seat = this.seats[seatIdx];
    if (!seat || !seat.isHuman || !seat.isConnected) return null;
    if (!voiceConfigured()) return null;
    const cfg = voiceConfig();
    const room = voiceRoomName(this.roomId);
    const identity = `seat${seatIdx}-${seat.sessionId || "anon"}`;
    return {
      voiceUrl: cfg.url,
      voiceRoom: room,
      voiceToken: makeLiveKitToken({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        room,
        identity,
        name: seat.name,
      }),
    };
  }

  // Per-recipient init: each human sees only their own hand (fog of war §3.4)
  sendInitTo(seatIdx) {
    const ws = this.sockets[seatIdx];
    if (!ws) return;
    const payload = {
      t: "init",
      room: this.roomId,
      you: seatIdx,
      seats: this.seats.map((s) => ({
        seat: s.seat, team: s.team, name: s.name, isBot: s.isBot, cardsLeft: s.cardsLeft,
      })),
      hand: this.seats[seatIdx].hand.map((c) => this.cardView(c)),
      kittySize: KITTY_SIZE,
      kittyLeft: KITTY_SIZE - this.kittyIdx,
      kittyActive: this.trickNumber <= KITTY_TRICKS && this.kittyIdx < this.kitty.length,
      trickNumber: this.trickNumber,
      leadSuit: this.leadSuit,
      trumpSuit: this.trumpSuit,
      trumpDeclarerSeat: this.trumpDeclarerSeat,
      activeSeat: this.activeSeat,
      leadSeat: this.leadSeat,
      score: this.score,
      capturedTens: this.capturedTens,
      tricksWon: { ...this.tricksWon },
      turnTime: this.turnTime,
      playedCards: this.playedCards.map((p) => ({ seat: p.seat, card: this.cardView(p.card), playOrder: p.playOrder })),
      totalTens: TOTAL_TENS,
      winTens: WIN_TENS,
      _ts: Date.now(),
    };
    // Voice is match-only: tokens are minted once the room is in PLAYING. They
    // are NOT sent in the lobby. Reconnect re-mints a fresh token here too.
    if (this.matchState === "PLAYING") {
      const voice = this.voiceTokenForSeat(seatIdx);
      if (voice) Object.assign(payload, voice);
    }
    safeSend(ws, payload);
  }

  // Fan out to all connected human sockets
  broadcast(msg) {
    const data = { ...msg, _ts: Date.now() };
    for (const seatIdx in this.sockets) safeSend(this.sockets[seatIdx], data);
  }
  // Fan out only to humans on a given team (for team chat — spec §1.2)
  broadcastToTeam(team, msg) {
    const data = { ...msg, _ts: Date.now() };
    for (const seatIdx in this.sockets) {
      if (this.seats[seatIdx].team === team) safeSend(this.sockets[seatIdx], data);
    }
  }
  sendErrorTo(seatIdx, message) { safeSend(this.sockets[seatIdx], { t: "error", message }); }

  // Clean up all timers (used when the room is destroyed)
  clearTimers() {
    this.stopTurnTimer();
    this.clearBot();
    if (this.resolveHandle) { clearTimeout(this.resolveHandle); this.resolveHandle = null; }
    if (this.leadSelectTimer) { clearTimeout(this.leadSelectTimer); this.leadSelectTimer = null; }
    for (const k in this.graceHandles) clearTimeout(this.graceHandles[k]);
    this.graceHandles = {};
  }
}

function cardLabel(card) {
  const rankName = { 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
  const suitGlyph = { SPADES: "♠", HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣" };
  return `${rankName[card.rank]}${suitGlyph[card.suit]}`;
}
function safeSend(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}
