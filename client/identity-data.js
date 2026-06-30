// Client-side mirror of shared/identity.js (the client loads plain scripts, not
// ESM, so it can't import the shared module). Keep this in sync with the palette
// + country list there. flagEmoji + the flag/avatar validation live here too.
window.IDENTITY = (function () {
  // Curated avatar palette — must match shared/identity.js AVATAR_OPTIONS.
  const AVATAR_OPTIONS = [
    "🦊", "🐉", "🦁", "🐯", "🐺", "🦅", "🦉", "🐙", "🦄", "🐲",
    "🐢", "🦈", "🐝", "🦋", "🦂", "🐍", "🐳", "🦓", "🐒", "🦝",
    "👑", "🤴", "👸", "🦸", "🥷", "🧙", "🧛", "🤖", "👽", "💀",
    "🎭", "⚡", "🔥", "⭐", "💎", "🎯", "🏆", "🎲", "♠️", "♥️",
    "♦️", "♣️", "🍀", "🌟", "🗝️", "🌀"
  ];
  const AVATAR_SET = new Set(AVATAR_OPTIONS);

  // Curated country list — must match shared/identity.js COUNTRY_OPTIONS.
  const COUNTRY_OPTIONS = [
    { code: "IN", name: "India" }, { code: "US", name: "United States" }, { code: "GB", name: "United Kingdom" },
    { code: "CA", name: "Canada" }, { code: "PK", name: "Pakistan" }, { code: "BD", name: "Bangladesh" },
    { code: "AU", name: "Australia" }, { code: "AE", name: "United Arab Emirates" }, { code: "SA", name: "Saudi Arabia" },
    { code: "SG", name: "Singapore" }, { code: "MY", name: "Malaysia" }, { code: "LK", name: "Sri Lanka" },
    { code: "NP", name: "Nepal" }, { code: "ZA", name: "South Africa" }, { code: "NZ", name: "New Zealand" },
    { code: "IE", name: "Ireland" }, { code: "DE", name: "Germany" }, { code: "FR", name: "France" },
    { code: "NL", name: "Netherlands" }, { code: "ES", name: "Spain" }, { code: "IT", name: "Italy" },
    { code: "PT", name: "Portugal" }, { code: "CH", name: "Switzerland" }, { code: "SE", name: "Sweden" },
    { code: "NO", name: "Norway" }, { code: "DK", name: "Denmark" }, { code: "FI", name: "Finland" },
    { code: "PL", name: "Poland" }, { code: "BE", name: "Belgium" }, { code: "AT", name: "Austria" },
    { code: "GR", name: "Greece" }, { code: "TR", name: "Turkey" }, { code: "RU", name: "Russia" },
    { code: "UA", name: "Ukraine" }, { code: "BR", name: "Brazil" }, { code: "AR", name: "Argentina" },
    { code: "MX", name: "Mexico" }, { code: "CL", name: "Chile" }, { code: "CO", name: "Colombia" },
    { code: "PE", name: "Peru" }, { code: "EG", name: "Egypt" }, { code: "NG", name: "Nigeria" },
    { code: "KE", name: "Kenya" }, { code: "MA", name: "Morocco" }, { code: "GH", name: "Ghana" },
    { code: "JP", name: "Japan" }, { code: "KR", name: "South Korea" }, { code: "CN", name: "China" },
    { code: "HK", name: "Hong Kong" }, { code: "PH", name: "Philippines" }, { code: "ID", name: "Indonesia" },
    { code: "TH", name: "Thailand" }, { code: "VN", name: "Vietnam" }
  ];

  // Regional-indicator flag emoji. "" for non-2-letter input.
  function flagEmoji(code) {
    if (typeof code !== "string") return "";
    const cc = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return "";
    return String.fromCodePoint(
      0x1f1e6 + (cc.charCodeAt(0) - 65),
      0x1f1e6 + (cc.charCodeAt(1) - 65)
    );
  }

  // --- Phase 5: XP + levels. Mirror of shared/identity.js. ---
  // Level curve: reaching level L needs cumulative XP = 100*L*(L-1).
  function xpToReachLevel(level) {
    const L = Math.max(1, Math.floor(level));
    return 100 * L * (L - 1);
  }
  function levelFromXp(totalXp) {
    const xp = Math.max(0, Number.isFinite(totalXp) ? Math.floor(totalXp) : 0);
    let level = Math.ceil((1 + Math.sqrt(1 + xp / 25)) / 2);
    while (level > 1 && 100 * level * (level - 1) > xp) level--;
    while (100 * (level + 1) * level <= xp) level++;
    return Math.max(1, level);
  }
  // Powers the Profile XP bar: { level, floor, ceil, into, span }.
  function xpProgress(totalXp) {
    const xp = Math.max(0, Number.isFinite(totalXp) ? Math.floor(totalXp) : 0);
    const level = levelFromXp(xp);
    const floor = xpToReachLevel(level);
    const ceil = xpToReachLevel(level + 1);
    return { level, floor, ceil, into: xp - floor, span: ceil - floor };
  }

  return { AVATAR_OPTIONS, AVATAR_SET, COUNTRY_OPTIONS, flagEmoji, levelFromXp, xpToReachLevel, xpProgress };
})();
