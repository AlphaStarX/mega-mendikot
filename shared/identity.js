// Mega Mindikot 5v5 — Phase 4: player identity (player IDs, avatars, country flags).
//
// Pure, zero-dependency module shared by server + client. Defines the curated
// avatar palette + country list, the flag-emoji algorithm, validation helpers,
// and player-ID generation. No DB access here — generation's uniqueness check is
// done by the caller (it has the Prisma client).

// --- Player IDs (shareable codes) ---
// Unambiguous alphabet (no I/O/0/1) — matches the room-code generator's style.
export const PLAYER_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PLAYER_ID_LENGTH = 5;

// Generate one candidate player-ID code (without the leading #). The caller is
// responsible for checking uniqueness and retrying. Uses node:crypto when
// available (server); falls back to Math.random (client) — fine since the server
// re-checks uniqueness against the DB before persisting.
export function generatePlayerId() {
  let id = "";
  const rand =
    (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues)
      ? cryptoRand
      : mathRand;
  for (let i = 0; i < PLAYER_ID_LENGTH; i++) {
    id += PLAYER_ID_ALPHABET[rand(PLAYER_ID_ALPHABET.length) % PLAYER_ID_ALPHABET.length];
  }
  return id;
}
function cryptoRand(max) {
  const buf = new Uint8Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}
function mathRand(max) { return Math.floor(Math.random() * max); }

// --- Avatars (curated emoji palette) ---
// ~48 emoji across animals, faces, symbols, objects. No storage — the user's
// pick is stored as the emoji itself. isValidAvatar guards server input.
export const AVATAR_OPTIONS = [
  // animals
  "🦊", "🐉", "🦁", "🐯", "🐺", "🦅", "🦉", "🐙", "🦄", "🐲",
  "🐢", "🦈", "🐝", "🦋", "🦂", "🐍", "🐳", "🦓", "🐒", "🦝",
  // faces / people
  "👑", "🤴", "👸", "🦸", "🥷", "🧙", "🧛", "🤖", "👽", "💀",
  // symbols / objects
  "🎭", "⚡", "🔥", "⭐", "💎", "🎯", "🏆", "🎲", "♠️", "♥️",
  "♦️", "♣️", "🍀", "🌟", "🗝️", "🎭", "🌀", "🌀",
];
// Dedupe the palette (the duplicate 🎭/🌀 above are intentional spacers removed here).
export const AVATAR_SET = new Set(AVATAR_OPTIONS);

export function isValidAvatar(emoji) {
  return typeof emoji === "string" && AVATAR_SET.has(emoji);
}

// --- Countries (curated ~50, ISO 3166-1 alpha-2) ---
// Stored as the 2-letter code; rendered as a flag emoji via flagEmoji(). A full
// ISO list is overkill; this covers the most common origins for the player base
// and is easily extended later.
export const COUNTRY_OPTIONS = [
  { code: "IN", name: "India" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "AU", name: "Australia" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" },
  { code: "LK", name: "Sri Lanka" },
  { code: "NP", name: "Nepal" },
  { code: "ZA", name: "South Africa" },
  { code: "NZ", name: "New Zealand" },
  { code: "IE", name: "Ireland" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "CH", name: "Switzerland" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "PL", name: "Poland" },
  { code: "BE", name: "Belgium" },
  { code: "AT", name: "Austria" },
  { code: "GR", name: "Greece" },
  { code: "TR", name: "Turkey" },
  { code: "RU", name: "Russia" },
  { code: "UA", name: "Ukraine" },
  { code: "BR", name: "Brazil" },
  { code: "AR", name: "Argentina" },
  { code: "MX", name: "Mexico" },
  { code: "CL", name: "Chile" },
  { code: "CO", name: "Colombia" },
  { code: "PE", name: "Peru" },
  { code: "EG", name: "Egypt" },
  { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" },
  { code: "MA", name: "Morocco" },
  { code: "GH", name: "Ghana" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CN", name: "China" },
  { code: "HK", name: "Hong Kong" },
  { code: "PH", name: "Philippines" },
  { code: "ID", name: "Indonesia" },
  { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" },
];
const COUNTRY_SET = new Set(COUNTRY_OPTIONS.map((c) => c.code));

export function isValidCountry(code) {
  return typeof code === "string" && COUNTRY_SET.has(code.toUpperCase());
}

// --- Flag emoji (regional indicator symbol pairs) ---
// Standard algorithm: each uppercase letter A-Z maps to a regional indicator
// symbol (U+1F1E6 .. U+1F1FF = 'A' + 0x1F1E5). Two letters form a flag. Returns
// "" for anything that isn't a 2-letter code (lowercase input is uppercased).
export function flagEmoji(countryCode) {
  if (typeof countryCode !== "string") return "";
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  // Regional indicator symbols form a grapheme cluster the OS renders as a flag
  // (on platforms that support them; otherwise the two-letter code shows).
  return String.fromCodePoint(
    0x1f1e6 + (cc.charCodeAt(0) - 65),
    0x1f1e6 + (cc.charCodeAt(1) - 65)
  );
}
