// Mega Mindikot 5v5 — interactive "How to Play" tutorial + rulebook reference.
// Self-contained, no build step, no dependencies. Mirrors the client precedent
// of vendoring a local copy of the rules (client.js already ships
// computeWinningSeat). Exposes window.Tutorial { open, close, isLessonDone }.
//
// Everything is wrapped in an IIFE so this script's top-level declarations
// (e.g. $, card, el, GLYPH) never collide with client.js's globals. Only
// window.Tutorial escapes into global scope.
"use strict";
(function () {
// --- Vendored, dependency-free copy of the rules the demos need. ---
// KEEP IN SYNC WITH shared/rules.js (resolveTrickWinner / validatePlay / countTens).
// Vendored rather than imported so the client stays build-free; this matches the
// existing computeWinningSeat copy in client.js.
const GLYPH = { SPADES: "♠", HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣" };
const COLOR = { SPADES: "black", HEARTS: "red", DIAMONDS: "red", CLUBS: "black" };
const RNAME = { 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

// Resolve which played card wins a trick. Mirrors shared/rules.js resolveTrickWinner.
// playedCards: [{seat, card:{suit,rank}, playOrder}]. Returns the winning play.
function tutResolve(playedCards, leadSuit, trumpSuit) {
  if (!playedCards.length) return null;
  const candidates = trumpSuit
    ? playedCards.filter((p) => p.card.suit === trumpSuit)
    : playedCards.filter((p) => p.card.suit === leadSuit);
  const pool = candidates.length ? candidates : playedCards.filter((p) => p.card.suit === leadSuit);
  const final = pool.length ? pool : playedCards;
  let maxRank = -1;
  for (const p of final) if (p.card.rank > maxRank) maxRank = p.card.rank;
  const top = final.filter((p) => p.card.rank === maxRank);
  let winner = top[0];
  for (let i = 1; i < top.length; i++) if (top[i].playOrder > winner.playOrder) winner = top[i];
  return winner;
}
// Is this card a legal play given the hand and lead suit? Mirrors validatePlay.
function tutLegal(card, hand, leadSuit) {
  if (!hand.some((c) => c.id === card.id)) return false;
  if (leadSuit && card.suit !== leadSuit) return !hand.some((c) => c.suit === leadSuit);
  return true;
}
function tutCountTens(cards) { return cards.reduce((n, c) => n + (c.rank === 10 ? 1 : 0), 0); }

// Build a unique card object for demo hands. d = deck index (keeps ids unique so
// duplicates are representable — important for the Duplicate Rule demo).
function card(suit, rank, d = 0) {
  return { id: `c_${d}_${suit}_${rank}`, suit, rank };
}

// ============================================================================
// INTERACTIVE LESSONS — hands-on steps distilled from RULEBOOK.md.
// Each lesson: { id, title, teach, demo }.
//   demo(state) returns the initial demo state object, OR a render function
//   is provided via `setup(host, state, advance)` for interactive steps.
// ============================================================================

const LESSONS = [
  {
    id: "objective",
    title: "The Objective",
    teach:
      `<p>Mega Mindikot 5v5 is a <b>team</b> game. Two teams of five race to capture the deck's <b>24 Tens</b>.</p>` +
      `<p>A <b>Ten</b> (rank <b>10</b>) is also called a <b>Mendi</b>. Tens are the <b>only</b> cards that count toward winning — nothing else matters.</p>` +
      `<p class="tut-callout">🎯 <b>Goal: be the first team to capture 13 of the 24 Tens.</b> The match ends the instant a team hits 13.</p>` +
      `<p class="tut-sub">Tap "Show me" to see a capture pile and count its Tens.</p>`,
    setup: setupObjectiveDemo,
  },
  {
    id: "follow",
    title: "Follow Suit",
    teach:
      `<p>Whoever plays first sets the <b>Lead Suit</b> (the suit of their card). Every other player <b>must play a card of that suit</b> if they have one.</p>` +
      `<ul class="tut-list"><li>Hold a Lead Suit card? You <b>must</b> play one (no exceptions).</li>` +
      `<li>Hold <b>none</b> of the Lead Suit? You may play any other card (off-suit) — see the next lessons.</li></ul>` +
      `<p class="tut-callout">👇 In this demo hand, the Lead Suit is <b>${GLYPH.HEARTS} Hearts</b>. Tap each card to see whether it's legal.</p>`,
    setup: setupFollowDemo,
  },
  {
    id: "trump",
    title: "Dynamic Trump",
    teach:
      `<p>At the start, there is <b>no trump</b>. Trump is created during play:</p>` +
      `<p class="tut-callout">The <b>first player who can't follow suit</b> plays an off-suit card — and that card's suit becomes the <b>permanent Trump</b> for the entire match.</p>` +
      `<ul class="tut-list"><li>Trump <b>beats any Lead Suit card</b>, regardless of rank.</li>` +
      `<li>Once set, trump <b>never changes</b>.</li>` +
      `<li>The lead player can never declare trump — their card defines the Lead Suit.</li></ul>` +
      `<p class="tut-sub">Tap "Show me" to watch the first off-suit play set trump.</p>`,
    setup: setupTrumpDemo,
  },
  {
    id: "resolve",
    title: "Winning a Trick",
    teach:
      `<p>Once all 10 players have played, the trick resolves in this order:</p>` +
      `<ol class="tut-list"><li>If any <b>Trump</b> was played → the <b>highest trump</b> wins.</li>` +
      `<li>Otherwise → the <b>highest Lead Suit card</b> wins.</li>` +
      `<li><b>Discards</b> (neither Lead nor Trump) can <b>never win</b>, no matter how high.</li></ol>` +
      `<p class="tut-sub">Step through real examples below — the winner is highlighted in gold, with an explanation.</p>`,
    setup: setupResolveDemo,
  },
  {
    id: "duplicate",
    title: "Last Identical Wins",
    teach:
      `<p>The deck has <b>6 copies of every card</b>, so identical cards often meet in one trick.</p>` +
      `<p class="tut-callout">When two or more identical cards tie for the win, the <b>last one played</b> wins. Acting later is an advantage!</p>` +
      `<p class="tut-sub">In the demo, two players each play the Ace of Hearts. Watch which one wins.</p>`,
    setup: setupDuplicateDemo,
  },
  {
    id: "winning",
    title: "How to Win",
    teach:
      `<p class="tut-callout">🏁 First team to <b>13 Tens</b> wins instantly — even mid-match.</p>` +
      `<p>A Ten revealed from the <b>kitty</b> (12 hidden cards, one shown per trick for the first 12 tricks) also counts and can trigger the instant win.</p>` +
      `<p>If all 18 tricks are played and it's <b>12–12</b>, the only tie possible: the team that won the <b>last (18th) trick</b> wins.</p>` +
      `<p class="tut-sub">There are no draws — every match has a clear winner.</p>`,
    setup: setupWinningDemo,
  },
];

// --- Demo setups -------------------------------------------------------------

// Lesson 1: a capture pile; count its Tens interactively.
function setupObjectiveDemo(host) {
  const pile = [
    card("HEARTS", 10, 0), card("CLUBS", 13, 0), card("SPADES", 7, 0),
    card("DIAMONDS", 10, 0), card("HEARTS", 14, 0), card("CLUBS", 10, 0),
    card("SPADES", 9, 0), card("DIAMONDS", 8, 0),
  ];
  const answer = tutCountTens(pile);
  let revealed = false;
  const draw = () => {
    host.innerHTML =
      `<p class="tut-q">How many <b>Tens (Mendis)</b> are in this captured pile? (rank = 10)</p>` +
      `<div class="tut-pile">${pile.map((c) => miniCard(c)).join("")}</div>` +
      `<div class="tut-count-row">${
        [0, 1, 2, 3, 4].map((n) =>
          `<button class="tut-count-btn" data-n="${n}">${n}</button>`).join("")
      }</div>` +
      `<p class="tut-feedback"></p>`;
    host.querySelectorAll(".tut-count-btn").forEach((b) => {
      b.addEventListener("click", () => {
        revealed = true;
        const guess = parseInt(b.dataset.n, 10);
        const fb = host.querySelector(".tut-feedback");
        const ok = guess === answer;
        fb.innerHTML = ok
          ? `✅ Correct — there are <b>${answer}</b> Tens in this pile. Your team just scored <b>${answer}</b> Tens.`
          : `❌ Not quite. Count the cards showing <b>10</b> — there are <b>${answer}</b> Tens here.`;
        fb.className = "tut-feedback " + (ok ? "ok" : "no");
        host.querySelectorAll(".tut-count-btn").forEach((bb) =>
          bb.classList.toggle("picked", parseInt(bb.dataset.n, 10) === answer));
      });
    });
  };
  draw();
  return () => { revealed = true; }; // teardown (no-op; demo is self-contained)
}

// Lesson 2: follow-suit legality on a sample hand.
function setupFollowDemo(host) {
  const leadSuit = "HEARTS";
  const hand = [
    card("HEARTS", 8, 0), card("HEARTS", 13, 0),   // legal (lead suit)
    card("SPADES", 14, 0), card("CLUBS", 10, 0),   // illegal (you hold hearts)
    card("DIAMONDS", 7, 0),
  ];
  const draw = () => {
    host.innerHTML =
      `<p class="tut-q">Lead suit is <b>${GLYPH[leadSuit]} ${cap(leadSuit)}</b>. Tap cards — legal ones glow gold, illegal ones dim out.</p>` +
      `<div class="tut-hand"></div>` +
      `<p class="tut-feedback">Because you hold Hearts, <b>only Hearts are legal</b>. The off-suit cards are off-limits.</p>`;
    const handEl = host.querySelector(".tut-hand");
    hand.forEach((c) => {
      const legal = tutLegal(c, hand, leadSuit);
      const el = document.createElement("div");
      el.className = "card" + (COLOR[c.suit] === "red" ? " red" : "") + (legal ? " playable" : " disabled");
      el.innerHTML = `<div class="rank">${RNAME[c.rank]}</div><div class="suit">${GLYPH[c.suit]}</div>`;
      el.addEventListener("click", () => {
        el.animate(
          legal ? [{ transform: "scale(1.08)" }, { transform: "scale(1)" }] : [{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
          { duration: 180 });
      });
      handEl.appendChild(el);
    });
  };
  draw();
  return () => {};
}

// Lesson 3: the first off-suit play establishes trump.
function setupTrumpDemo(host) {
  const seq = [
    { seat: 0, card: card("CLUBS", 13, 0), note: "Seat 0 leads the <b>King of Clubs</b>. Clubs is the <b>Lead Suit</b>. No trump yet." },
    { seat: 2, card: card("CLUBS", 9, 0), note: "Seat 2 follows Clubs (required)." },
    { seat: 4, card: card("HEARTS", 7, 0), note: "Seat 4 has <b>no Clubs</b>! They play the <b>7 of Hearts</b> — an off-suit card." },
  ];
  const after = "<b>♥ Hearts is now the permanent Trump Suit</b> for the rest of the match. From now on, any Heart beats every Club (and every discard).";
  runSequencedTrick(host, seq, { leadSuit: "CLUBS", trumpDeclaredAt: 2, kicker: after, revealWinner: false });
  return () => {};
}

// Lesson 4: step-through of the 5 RULEBOOK §9 worked examples.
function setupResolveDemo(host) {
  const examples = [
    {
      label: "Trump beats a higher lead card",
      lead: "HEARTS", trump: "SPADES",
      plays: [
        { seat: 0, card: card("HEARTS", 14, 0) },   // A♥
        { seat: 1, card: card("HEARTS", 9, 0) },
        { seat: 2, card: card("SPADES", 8, 0) },    // 8♠ trump
        { seat: 3, card: card("HEARTS", 11, 0) },
      ],
      why: "Even though A♥ (14) is higher than 8♠ (8), <b>trump beats any Lead Suit card</b>. Seat 2 wins with the 8 of Spades.",
    },
    {
      label: "Discard can never win",
      lead: "HEARTS", trump: "SPADES",
      plays: [
        { seat: 0, card: card("HEARTS", 8, 0) },    // 8♥ lead
        { seat: 1, card: card("DIAMONDS", 14, 0) }, // A♦ — discard
        { seat: 2, card: card("HEARTS", 7, 0) },
      ],
      why: "The A♦ is a <b>discard</b> (neither Hearts nor Spades). Discards are ignored — the <b>8 of Hearts</b> (Lead Suit) wins.",
    },
    {
      label: "Highest trump wins",
      lead: "DIAMONDS", trump: "SPADES",
      plays: [
        { seat: 0, card: card("DIAMONDS", 12, 0) },
        { seat: 1, card: card("SPADES", 9, 0) },    // trump
        { seat: 2, card: card("SPADES", 13, 0) },   // trump (highest)
        { seat: 3, card: card("SPADES", 7, 0) },    // trump
      ],
      why: "Three trumps were played. The highest is the <b>King of Spades</b> (13) — seat 2 wins.",
    },
  ];
  // Pick a fresh random-ish example each open, then allow cycling.
  let i = 0;
  const draw = () => {
    const ex = examples[i];
    host.innerHTML =
      `<div class="tut-ex-head">Example ${i + 1} of ${examples.length}: ${ex.label}</div>` +
      `<div class="tut-context">Lead: <b>${GLYPH[ex.lead]} ${cap(ex.lead)}</b> · Trump: <b>${GLYPH[ex.trump]} ${cap(ex.trump)}</b></div>` +
      `<div class="tut-trick-row"></div>` +
      `<button class="tut-resolve-btn">Resolve trick →</button>` +
      `<p class="tut-feedback"></p>` +
      `<div class="tut-nav"><button class="tut-prev-ex">‹ Prev example</button><button class="tut-next-ex">Next example ›</button></div>`;
    renderTrickRow(host.querySelector(".tut-trick-row"), ex.plays, { leadSuit: ex.lead, trumpSuit: ex.trump, resolved: false });
    host.querySelector(".tut-resolve-btn").addEventListener("click", () => {
      const winner = tutResolve(ex.plays.map((p, idx) => ({ ...p, playOrder: idx })), ex.lead, ex.trump);
      renderTrickRow(host.querySelector(".tut-trick-row"), ex.plays, { leadSuit: ex.lead, trumpSuit: ex.trump, resolved: true, winnerSeat: winner.seat });
      host.querySelector(".tut-resolve-btn").disabled = true;
      const fb = host.querySelector(".tut-feedback");
      fb.className = "tut-feedback ok";
      fb.innerHTML = `<b>Winner: Seat ${winner.seat}</b> (${RNAME[winner.card.rank]}${GLYPH[winner.card.suit]}). ${ex.why}`;
    });
    host.querySelector(".tut-prev-ex").addEventListener("click", () => { i = (i - 1 + examples.length) % examples.length; draw(); });
    host.querySelector(".tut-next-ex").addEventListener("click", () => { i = (i + 1) % examples.length; draw(); });
  };
  draw();
  return () => {};
}

// Lesson 5: duplicate rule — two aces, last wins.
function setupDuplicateDemo(host) {
  const lead = "HEARTS";
  const plays = [
    { seat: 1, card: card("HEARTS", 9, 0) },
    { seat: 3, card: card("HEARTS", 14, 0) },   // first A♥
    { seat: 5, card: card("HEARTS", 13, 0) },   // K♥
    { seat: 7, card: card("HEARTS", 14, 1) },   // second A♥ (different deck copy)
  ];
  const why = "Two Aces of Hearts tie for highest. The <b>last one played</b> (seat 7, playOrder 3) wins the tie.";
  runSequencedTrick(host,
    plays.map((p, idx) => ({ ...p, note: idx === 3 ? "Seat 7 plays <b>another</b> Ace of Hearts — a duplicate!" : `Seat ${p.seat} plays ${RNAME[p.card.rank]}${GLYPH[p.card.suit]}.` })),
    { leadSuit: lead, revealWinner: true, whyText: why });
  return () => {};
}

// Lesson 6: scoreboard progress mock.
function setupWinningDemo(host) {
  host.innerHTML =
    `<p class="tut-q">Imagine the score is <b>Team A: 12</b> — <b>Team B: 11</b>, and Team A wins a trick containing one Ten:</p>` +
    `<div class="tut-score-demo">
       <div class="tut-team a"><span class="dot a"></span> Team A<div class="tut-bar"><div class="tut-fill a" style="width:92%"></div></div><b>12 → 13</b></div>
       <div class="tut-team b"><span class="dot b"></span> Team B<div class="tut-bar"><div class="tut-fill b" style="width:85%"></div></div><b>11</b></div>
     </div>
     <p class="tut-feedback ok">🏆 Team A reaches <b>13</b> and wins <b>instantly</b> — the remaining tricks aren't played. 13 of 24 Tens is all it takes.</p>
     <p class="tut-sub">If instead it ended <b>12–12</b>, the team that won the <b>most tricks</b> takes the match.</p>`;
  return () => {};
}

// --- Shared demo renderers ---------------------------------------------------

// Render a single small static card (for piles / hands inside demos).
function miniCard(c) {
  return `<div class="tut-mini card${COLOR[c.suit] === "red" ? " red" : ""}${c.rank === 10 ? " is-ten" : ""}">
            <div class="rank">${RNAME[c.rank]}</div><div class="suit">${GLYPH[c.suit]}</div>
          </div>`;
}

// Render a row of played cards for a trick (optionally resolved → highlight).
function renderTrickRow(host, plays, { leadSuit, trumpSuit, resolved, winnerSeat }) {
  host.innerHTML = "";
  plays.forEach((p, idx) => {
    const isTrump = trumpSuit && p.card.suit === trumpSuit;
    const isWin = resolved && p.seat === winnerSeat;
    const el = document.createElement("div");
    el.className = "table-card" + (COLOR[p.card.suit] === "red" ? " red" : "") + (isWin ? " winning" : "") + (isTrump ? " trump" : "");
    el.style.position = "relative";
    el.style.left = "auto"; el.style.top = "auto";
    el.style.opacity = "1"; el.style.animation = "none";
    el.innerHTML =
      `<div class="tc-seat">Seat ${p.seat}</div>` +
      `<div class="tc-rank">${RNAME[p.card.rank]}</div>` +
      `<div class="tc-suit">${GLYPH[p.card.suit]}</div>` +
      (isTrump ? '<div class="tc-badge trump-badge">TRUMP</div>' : "") +
      (isWin ? '<div class="tc-badge win-badge">WINNER</div>' : "") +
      `<div class="tc-order">play ${idx}</div>`;
    host.appendChild(el);
  });
}

// Run a trick that plays out one card at a time on tap, with a running note.
function runSequencedTrick(host, seq, opts) {
  const { leadSuit, trumpSuit = "", trumpDeclaredAt = -1, revealWinner = false, kicker = "", whyText = "" } = opts;
  let step = 0;
  const draw = () => {
    const played = seq.slice(0, step);
    const trumpNow = trumpDeclaredAt >= 0 && step > trumpDeclaredAt ? (trumpSuit || seq[trumpDeclaredAt].card.suit) : trumpSuit;
    let winnerSeat = null;
    if (revealWinner && step >= seq.length) {
      const w = tutResolve(seq.map((p, idx) => ({ ...p, playOrder: idx })), leadSuit, trumpNow);
      winnerSeat = w ? w.seat : null;
    }
    const note = step === 0
      ? "Tap <b>Play next card</b> to deal the trick one card at a time."
      : seq[step - 1].note;
    const done = step >= seq.length;
    host.innerHTML =
      `<div class="tut-context">Lead: <b>${GLYPH[leadSuit]} ${cap(leadSuit)}</b>${
        trumpNow ? ` · Trump: <b>${GLYPH[trumpNow]} ${cap(trumpNow)}</b>` : " · Trump: <b>— (none yet)</b>"}</div>` +
      `<div class="tut-trick-row"></div>` +
      `<p class="tut-note">${note}</p>` +
      `<p class="tut-feedback ${done && (kicker || whyText) ? "ok" : ""}">${done ? (whyText || kicker || "") : ""}</p>` +
      (done ? "" : `<button class="tut-resolve-btn">Play next card →</button>`);
    renderTrickRow(host.querySelector(".tut-trick-row"), played, { leadSuit, trumpSuit: trumpNow, resolved: done && revealWinner, winnerSeat });
    const btn = host.querySelector(".tut-resolve-btn");
    if (btn) btn.addEventListener("click", () => { step++; draw(); });
  };
  draw();
}

function cap(s) { return s.charAt(0) + s.slice(1).toLowerCase(); }

// ============================================================================
// RULEBOOK REFERENCE — distilled, searchable chapters from RULEBOOK.md.
// Each: { id, title, icon, html }.
// ============================================================================

const RULES = [
  {
    id: "overview", title: "Game Overview", icon: "♠",
    html:
      `<p><b>Mega Mindikot 5v5</b> is a team-based trick-taking card game for <b>10 players</b> (two teams of five), inspired by the Indian game <i>Mendikot</i>.</p>
       <p>It uses a giant <b>192-card mega deck</b> built from six combined decks — so every card exists <b>six times</b>. That creates ties, surprises, and a signature rule: <b>last identical card wins</b>.</p>
       <h4>What makes it special</h4>
       <ul class="tut-list">
         <li><b>Team play</b> — win or lose together with your four teammates.</li>
         <li><b>Dynamic trump</b> — created during play by the first player who can't follow suit.</li>
         <li><b>Duplicate Rule</b> — with six copies of each card, the <b>last</b> identical card wins ties.</li>
         <li><b>The Kitty</b> — 12 hidden cards; one is revealed per trick for the first 12 tricks and captured by the winner.</li>
         <li><b>Instant win</b> — hit 13 Tens and you win on the spot.</li>
       </ul>`,
  },
  {
    id: "components", title: "Components & Deck", icon: "♣",
    html:
      `<h4>The Mega Deck (192 cards)</h4>
       <p>Built from <b>6 standard decks</b>, each trimmed to ranks <b>7–A</b> (all 2s–6s removed). That's 32 cards × 6 = <b>192</b>.</p>
       <table class="tut-table"><tr><th>Suit</th><th>Ranks</th><th>× 6 decks</th></tr>
         <tr><td>♠ Spades</td><td>7–A</td><td>48</td></tr>
         <tr><td>♥ Hearts</td><td>7–A</td><td>48</td></tr>
         <tr><td>♦ Diamonds</td><td>7–A</td><td>48</td></tr>
         <tr><td>♣ Clubs</td><td>7–A</td><td>48</td></tr>
         <tr><td><b>Total</b></td><td></td><td><b>192</b></td></tr>
       </table>
       <p class="tut-callout">There are <b>24 Tens</b> (4 suits × 6 decks). You need <b>13</b> to win.</p>
       <h4>The Kitty</h4>
       <p>12 cards placed face-down. Over the first 12 tricks, one is revealed after each trick and captured by that trick's winner. A <b>kitty Ten counts</b> toward your score.</p>
       <h4>Seating</h4>
       <p>10 seats (0–9) alternate teams. <b>Even seats {0,2,4,6,8} = Team A</b>, <b>odd seats {1,3,5,7,9} = Team B</b>. Play moves clockwise.</p>`,
  },
  {
    id: "winning", title: "Winning", icon: "🏆",
    html:
      `<h4>Victory: capture 13 Tens</h4>
       <p class="tut-callout">The first team to capture <b>13 of the 24 Tens</b> wins the match <b>immediately</b>.</p>
       <p>This is checked at the end of every trick. A captured <b>kitty Ten</b> also counts and can trigger the instant win.</p>
       <h4>The 12–12 deadlock</h4>
       <p>If all 18 tricks are played and the score is tied <b>12–12</b> (the only possible Ten-count tie), the team that won the <b>most tricks</b> wins. If tricks are tied too (9–9), it's a <b>draw</b>.</p>
       <p>There are <b>no draws</b> — every match has one clear winner.</p>`,
  },
  {
    id: "turn", title: "Turn Structure", icon: "⏱",
    html:
      `<p>A match is <b>18 tricks</b>. Each trick:</p>
       <ol class="tut-list">
         <li><b>Lead</b> plays first → their card's suit is the <b>Lead Suit</b>.</li>
         <li>Players 2–10 play clockwise — <b>follow suit if able</b>, else play off-suit (which may set trump).</li>
         <li>Once all 10 play, the trick <b>resolves</b>: determine winner, reveal kitty card (first 12 tricks), winner captures all, add Tens to score.</li>
         <li>Check for instant win (13 Tens?).</li>
         <li>Winner leads the next trick.</li>
       </ol>
       <h4>Turn timer</h4>
       <p>Each player has <b>20 seconds</b> to play. If the timer runs out, a card is <b>auto-played</b> for them. Time out <b>twice in a row</b> and you're flagged <b>AFK</b> — your turns are auto-played instantly until you play manually.</p>`,
  },
  {
    id: "actions", title: "Player Actions", icon: "✋",
    html:
      `<h4>Lead a trick</h4><p>Play the first card (any card). Its suit becomes the Lead Suit. The leader <b>cannot</b> declare trump.</p>
       <h4>Follow suit</h4><p>If you hold a Lead Suit card you <b>must</b> play one — you may choose which (high or low).</p>
       <h4>Play off-suit (declare trump or discard)</h4>
       <ul class="tut-list">
         <li><b>No trump yet:</b> your off-suit card's suit becomes the <b>permanent Trump</b>.</li>
         <li><b>Trump already set:</b> a Trump card can win; any other off-suit card is a <b>discard</b> (can never win).</li>
       </ul>
       <h4>Auto-play</h4><p>On timeout/AFK the system plays the safest card: lowest Lead Suit → lowest non-trump off-suit → lowest of your most-held suit.</p>`,
  },
  {
    id: "resolution", title: "Trick Resolution", icon: "⚔",
    html:
      `<p>The winner is found in strict order:</p>
       <ol class="tut-list">
         <li><b>Trump played?</b> → the <b>highest trump</b> wins.</li>
         <li><b>No trump?</b> → the <b>highest Lead Suit card</b> wins.</li>
         <li><b>Discards</b> (neither Lead nor Trump) are <b>ineligible</b> — ignored entirely.</li>
         <li><b>Tie?</b> The <b>last identical card played</b> wins (Duplicate Rule).</li>
       </ol>
       <table class="tut-table"><tr><th>Situation</th><th>Winner</th></tr>
         <tr><td>Trump cards played</td><td>Highest trump</td></tr>
         <tr><td>No trump</td><td>Highest Lead Suit</td></tr>
         <tr><td>Tie at the top</td><td>Last identical played</td></tr>
         <tr><td>Only discards + lead</td><td>Highest Lead Suit</td></tr>
       </table>`,
  },
  {
    id: "special", title: "Special Rules", icon: "★",
    html:
      `<ul class="tut-list">
         <li><b>Lead player can never declare trump</b> — their card defines the Lead Suit.</li>
         <li><b>Trump is permanent</b> once set by the first off-suit play.</li>
         <li><b>Discards can never win</b> — even an Ace of a discard suit loses to a 7 of the Lead Suit.</li>
         <li><b>Duplicate Rule always applies</b> — last identical card wins, for both Lead Suit and Trump ties.</li>
         <li><b>Kitty Ten triggers instant win</b> immediately.</li>
         <li><b>Team-only communication</b> — coordinate only with your own team.</li>
       </ul>`,
  },
  {
    id: "faq", title: "FAQ", icon: "?",
    html:
      `<details><summary>Do I have to play the Lead Suit if I have it?</summary><p><b>Yes.</b> If you hold even one Lead Suit card, you must play one.</p></details>
       <details><summary>What if I don't have any Lead Suit cards?</summary><p>Play any card. If no trump exists yet, your card's suit becomes trump. Otherwise it's a trump (can win) or a discard (can't win).</p></details>
       <details><summary>Can trump be changed after it's set?</summary><p><b>No.</b> It's fixed for the whole match.</p></details>
       <details><summary>Two players both played the Ace of Hearts — who wins?</summary><p>The one who played it <b>last</b> (the Duplicate Rule).</p></details>
       <details><summary>My Ace of Diamonds didn't win — why?</summary><p>It was a <b>discard</b> (neither Lead Suit nor Trump). Discards can never win, no matter their rank.</p></details>
       <details><summary>Does a Ten from the kitty count?</summary><p><b>Yes</b> — immediately, and it can even trigger the instant 13-Ten win.</p></details>
       <details><summary>What if it's 12–12 after all 18 tricks?</summary><p>The team that won the <b>most tricks</b> wins; if tricks are also tied, it's a draw.</p></details>`,
  },
  {
    id: "quickstart", title: "Quick Start", icon: "⚡",
    html:
      `<h4>Setup</h4>
       <ol class="tut-list">
         <li><b>192 cards</b> (6 decks, ranks 7–A).</li>
         <li><b>10 players</b>, alternating teams (even = A, odd = B).</li>
         <li><b>Deal 18 cards</b> each; remaining <b>12</b> = kitty.</li>
         <li>Lead selection: high card leads trick 1.</li>
       </ol>
       <h4>Turn flow</h4>
       <ol class="tut-list">
         <li>Lead plays → sets Lead Suit.</li>
         <li>Clockwise — <b>follow suit if able</b>; else off-suit (first off-suit sets Trump).</li>
         <li>Highest <b>Trump</b> wins, else highest <b>Lead Suit</b>; ties → <b>last played</b>.</li>
       </ol>
       <p class="tut-callout">🎯 First to <b>13 Tens</b> wins. 12–12 → team with most tricks wins.</p>
       <h4>5 rules to remember</h4>
       <ol class="tut-list">
         <li>✅ Follow suit if you have it.</li>
         <li>✅ First off-suit play = Trump (permanent).</li>
         <li>✅ Trump beats any Lead Suit card.</li>
         <li>✅ Discards can never win.</li>
         <li>✅ Last identical card wins ties.</li>
       </ol>`,
  },
];

// ============================================================================
// OVERLAY RUNTIME
// ============================================================================

const DONE_KEY = "mm_tut_done";
let activeMode = null;     // "learn" | "rules"
let lessonIdx = 0;
let teardownDemo = null;
let escHandler = null;

function isLessonDone() { return localStorage.getItem(DONE_KEY) === "1"; }
function markDone() { localStorage.setItem(DONE_KEY, "1"); updateMenuBadge(); }

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// Build the overlay shell once (idempotent).
function ensureOverlay() {
  if (document.getElementById("tutorial-overlay")) return $("tutorial-overlay");
  const overlay = el("div", "tutorial-overlay hidden");
  overlay.id = "tutorial-overlay";
  overlay.innerHTML = `
    <div class="tutorial-shell" role="dialog" aria-modal="true" aria-label="How to Play">
      <button class="tutorial-close" title="Close (Esc)">✕</button>
      <div class="tutorial-tabs">
        <button class="tut-tab" data-tab="learn">📖 Learn</button>
        <button class="tut-tab" data-tab="rules">📚 Rules</button>
      </div>
      <div class="tutorial-body"></div>
    </div>`;
  document.getElementById("app").appendChild(overlay);

  overlay.querySelector(".tutorial-close").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll(".tut-tab").forEach((t) =>
    t.addEventListener("click", () => open(t.dataset.tab)));
  return overlay;
}

function open(mode) {
  const overlay = ensureOverlay();
  overlay.classList.remove("hidden");
  escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);
  setActiveTab(mode);
}

function close() {
  const overlay = $("tutorial-overlay");
  if (!overlay) return;
  if (teardownDemo) { teardownDemo(); teardownDemo = null; }
  overlay.classList.add("hidden");
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  activeMode = null;
}

function setActiveTab(mode) {
  activeMode = mode;
  const overlay = $("tutorial-overlay");
  overlay.querySelectorAll(".tut-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === mode));
  if (mode === "learn") renderLesson();
  else renderRules();
}

// --- Learn mode -------------------------------------------------------------

function renderLesson() {
  const body = $("tutorial-overlay").querySelector(".tutorial-body");
  body.innerHTML = "";
  const lesson = LESSONS[lessonIdx];

  const head = el("div", "tut-lesson-head");
  head.appendChild(el("div", "tut-progress", `Lesson ${lessonIdx + 1} of ${LESSONS.length}`));
  head.appendChild(el("div", "tut-dots",
    LESSONS.map((_, i) => `<span class="tut-dot ${i === lessonIdx ? "on" : ""} ${i < lessonIdx ? "done" : ""}"></span>`).join("")));
  body.appendChild(head);

  body.appendChild(el("h2", "tut-lesson-title", lesson.title));
  body.appendChild(el("div", "tut-teach", lesson.teach));

  const demoHost = el("div", "tut-demo");
  body.appendChild(demoHost);
  teardownDemo = lesson.setup(demoHost);

  const nav = el("div", "tut-lesson-nav");
  const prev = el("button", "tut-nav-btn tut-prev", "‹ Back");
  prev.disabled = lessonIdx === 0;
  prev.addEventListener("click", () => { if (lessonIdx > 0) { lessonIdx--; renderLesson(); } });
  const next = el("button", "tut-nav-btn tut-next primary");
  if (lessonIdx === LESSONS.length - 1) {
    next.textContent = "Finish ✓";
    next.addEventListener("click", () => { markDone(); close(); });
  } else {
    next.textContent = "Next ›";
    next.addEventListener("click", () => { lessonIdx++; renderLesson(); });
  }
  nav.appendChild(prev);
  nav.appendChild(el("span", "tut-nav-spacer"));
  nav.appendChild(next);
  body.appendChild(nav);
}

// --- Rules mode -------------------------------------------------------------

function renderRules() {
  const body = $("tutorial-overlay").querySelector(".tutorial-body");
  body.innerHTML = "";
  body.classList.add("rules-mode");

  const search = el("input", "tutorial-search");
  search.type = "search";
  search.placeholder = "Search the rules…";
  search.value = "";
  search.addEventListener("input", () => filterRules(search.value, nav, content));
  body.appendChild(search);

  const layout = el("div", "tut-rules-layout");
  const nav = el("nav", "tut-rules-nav");
  RULES.forEach((r) => nav.appendChild(el("button", "tut-rule-link",
    `<span class="tut-rule-icon">${r.icon}</span> ${r.title}`)));
  const content = el("div", "tut-rules-content");
  RULES.forEach((r) => content.appendChild(el("section", "tut-rule-section", `<h3>${r.title}</h3>${r.html}`)));
  layout.appendChild(nav);
  layout.appendChild(content);
  body.appendChild(layout);

  nav.querySelectorAll(".tut-rule-link").forEach((link, i) =>
    link.addEventListener("click", () => {
      content.querySelectorAll(".tut-rule-section")[i].scrollIntoView({ behavior: "smooth", block: "start" });
      nav.querySelectorAll(".tut-rule-link").forEach((l) => l.classList.remove("active"));
      link.classList.add("active");
    }));
  const first = nav.querySelector(".tut-rule-link");
  if (first) first.classList.add("active");
}

function filterRules(q, nav, content) {
  const query = q.trim().toLowerCase();
  const sections = content.querySelectorAll(".tut-rule-section");
  const links = nav.querySelectorAll(".tut-rule-link");
  sections.forEach((sec, i) => {
    const text = sec.textContent.toLowerCase();
    const show = !query || text.includes(query);
    sec.style.display = show ? "" : "none";
    links[i].style.display = show ? "" : "none";
    if (query && show) sec.unmarkPos = null;
  });
}

// Refresh the menu button's "done" badge state.
function updateMenuBadge() {
  const btn = document.getElementById("howto-btn");
  if (!btn) return;
  if (isLessonDone()) btn.classList.add("done");
  else btn.classList.remove("done");
}

const $ = (id) => document.getElementById(id);

// Expose the public API.
window.Tutorial = { open, close, isLessonDone };

// Once the menu button exists, sync its badge. (client.js wires the click.)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateMenuBadge);
} else {
  updateMenuBadge();
}

})(); // end IIFE
