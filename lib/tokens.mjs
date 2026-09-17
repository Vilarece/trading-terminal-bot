/**
 * Token lookup for "trade any token" (Sept 17, 2026).
 *
 * Uses Jupiter's Tokens API v2 search, which accepts either a symbol/name
 * ("bonk") or a mint address and returns price, liquidity, holder count,
 * verification status and audit flags. Verified live Sept 17, 2026:
 * works without an API key.
 *
 * Why "any token" is now possible when the README used to say it wasn't:
 * Jupiter Ultra collects the referral fee in SOL whenever SOL is one side
 * of the trade (confirmed live for SOL->WIF and WIF->SOL on a mint we have
 * no referral token account for: feeMint = SOL, feeBps = 50). Our referral
 * account already has a wSOL token account, so every SOL-paired buy or sell
 * pays us, whatever the other token is.
 */

const TOKENS_API = "https://api.jup.ag/tokens/v2";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const looksLikeMint = (s) => BASE58_RE.test((s || "").trim());

const cache = new Map(); // key -> { at, value }
const TTL_MS = 60_000;

function headers(apiKey) {
  return apiKey ? { "x-api-key": apiKey } : {};
}

async function search(query, apiKey) {
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(`${TOKENS_API}/search?query=${encodeURIComponent(query)}`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`Token search failed (${res.status})`);
  const value = await res.json();
  cache.set(key, { at: Date.now(), value });
  return Array.isArray(value) ? value : [];
}

const clean = (sym) => (sym || "").replace(/^\$/, "").toUpperCase();

/**
 * Resolve a user's input (symbol or mint) to one token.
 * - A mint address resolves to exactly that mint.
 * - A symbol prefers an exact symbol match, verified first, then by liquidity,
 *   so "/buy BONK" doesn't land on a copycat token.
 * Returns null if nothing matches.
 */
export async function resolveToken(input, apiKey) {
  const q = (input || "").trim();
  if (!q) return null;
  if (clean(q) === "SOL") return solToken();
  const results = await search(q, apiKey);
  if (looksLikeMint(q)) return results.find((t) => t.id === q) || null;
  const exact = results.filter((t) => clean(t.symbol) === clean(q));
  const pool = exact.length ? exact : [];
  pool.sort((a, b) => (Number(b.isVerified) - Number(a.isVerified)) || ((b.liquidity || 0) - (a.liquidity || 0)));
  return pool[0] || null;
}

function solToken() {
  return { id: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9, isVerified: true, liquidity: Infinity };
}

/** Plain-language risk flags shown before anyone buys. */
export function riskFlags(t) {
  const flags = [];
  if (!t.isVerified) flags.push("Not verified by Jupiter");
  if ((t.liquidity ?? 0) < 10_000) flags.push(`Low liquidity ($${fmtUsd(t.liquidity || 0)}) — large trades will move the price`);
  if (t.audit && t.audit.mintAuthorityDisabled === false) flags.push("Mint authority still enabled — more tokens can be created");
  if (t.audit && t.audit.freezeAuthorityDisabled === false) flags.push("Freeze authority enabled — your tokens could be frozen");
  if (t.audit && (t.audit.topHoldersPercentage ?? 0) > 50) flags.push(`Top holders own ${t.audit.topHoldersPercentage.toFixed(0)}% of supply`);
  if (t.organicScoreLabel === "low") flags.push("Low organic trading activity");
  return flags;
}

export function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(2);
}

export function fmtPrice(p) {
  const v = Number(p) || 0;
  if (v === 0) return "0";
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return v.toPrecision(4);
}

/** Small, safe summary for the trade page and API consumers. */
export function publicToken(t) {
  if (!t) return null;
  return {
    mint: t.id,
    symbol: clean(t.symbol),
    name: t.name,
    decimals: t.decimals,
    icon: t.icon || null,
    usdPrice: t.usdPrice ?? null,
    liquidity: Number.isFinite(t.liquidity) ? t.liquidity : null,
    mcap: t.mcap ?? null,
    holders: t.holderCount ?? null,
    verified: !!t.isVerified,
    change24h: t.stats24h?.priceChange ?? null,
    flags: t.id === SOL_MINT ? [] : riskFlags(t),
  };
}
