import "dotenv/config";
import express from "express";
import { buildSwapTransaction, getUsdPrice, SOL_MINT } from "./jupiter.mjs";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
// Sept 11, 2026: bumped default from 20 to 50 — Jupiter's Referral Program
// now enforces a 50bps *minimum* referral fee (same change Idea 1 got
// Sept 9). See jupiter.mjs's file-level comment for the full migration note.
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 50);
const REFERRAL_ACCOUNT = process.env.REFERRAL_ACCOUNT || "";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const SUPPORTED_TOKENS = JSON.parse(process.env.SUPPORTED_TOKENS_JSON || "[]");

// Core CORS headers every Actions client needs. Solana's Actions spec has
// picked up extra recommended headers (an action-version, a chain-id) as it
// matured — check the current @solana/actions package's ACTIONS_CORS_HEADERS
// export for the latest full set before relying on this being complete;
// these three are the load-bearing ones documented from the start.
const ACTIONS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function findToken(mint) {
  return SUPPORTED_TOKENS.find((t) => t.mint === mint);
}

function assertConfig() {
  const missing = [];
  if (!PUBLIC_BASE_URL || PUBLIC_BASE_URL.includes("REPLACE_")) missing.push("PUBLIC_BASE_URL");
  if (!REFERRAL_ACCOUNT || REFERRAL_ACCOUNT.includes("REPLACE_")) missing.push("REFERRAL_ACCOUNT");
  if (missing.length) {
    console.warn(`Warning: .env still has placeholder values for: ${missing.join(", ")}. Actions will fail until these are set.`);
  }
  if (SUPPORTED_TOKENS.length === 0) {
    console.warn("Warning: SUPPORTED_TOKENS_JSON is empty — no tokens are tradeable yet.");
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  for (const [k, v] of Object.entries(ACTIONS_CORS_HEADERS)) res.setHeader(k, v);
  next();
});
app.options("*", (req, res) => res.sendStatus(204));

// --- Discovery file: tells Blink-aware clients which URLs are Actions. ---
app.get("/actions.json", (req, res) => {
  res.json({
    rules: [
      { pathPattern: "/buy", apiPath: "/api/actions/buy" },
      { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
    ],
  });
});

// --- GET: metadata + preset-amount buttons for buying one token. ---
app.get("/api/actions/buy", async (req, res) => {
  const { mint } = req.query;
  const token = findToken(mint);
  if (!token) {
    return res.status(400).json({ error: `Unsupported token. Create a Referral Token Account for ${mint} at referral.jup.ag first — see README.` });
  }

  const feePct = (PLATFORM_FEE_BPS / 100).toFixed(2);
  res.json({
    type: "action",
    icon: `${PUBLIC_BASE_URL}/icon.png`,
    title: `Buy ${token.symbol}`,
    label: `Buy ${token.symbol}`,
    description:
      `Non-custodial buy of ${token.symbol}, routed through Jupiter. ` +
      `You sign this in your own wallet — this service never holds your keys or funds. ` +
      `A ${feePct}% fee is included in the transaction and will be visible in your wallet before you approve it.`,
    links: {
      actions: [
        { label: "0.1 SOL", href: `/api/actions/buy?mint=${mint}&amountSol=0.1` },
        { label: "0.5 SOL", href: `/api/actions/buy?mint=${mint}&amountSol=0.5` },
        { label: "1 SOL", href: `/api/actions/buy?mint=${mint}&amountSol=1` },
        {
          label: "Custom amount",
          href: `/api/actions/buy?mint=${mint}&amountSol={amount}`,
          parameters: [{ name: "amount", label: "Amount in SOL" }],
        },
      ],
    },
  });
});

// --- POST: build the actual unsigned transaction for the wallet to sign. ---
// See jupiter.mjs's file-level comment: this returns an /order-built
// transaction for a THIRD-PARTY Blink client to sign and submit — it does
// NOT call Jupiter's /execute itself (we never see the signature). Whether
// that self-submission path reliably lands on-chain is the open question
// flagged there; test this for real (small amount, real Blink client,
// confirm on Solscan) before treating Idea 3 as launch-ready.
app.post("/api/actions/buy", async (req, res) => {
  try {
    const { mint, amountSol } = req.query;
    const { account } = req.body || {};
    const token = findToken(mint);

    if (!token) return res.status(400).json({ error: `Unsupported token: ${mint}` });
    if (!account) return res.status(400).json({ error: "Missing account (your wallet's public key)" });
    const amt = Number(amountSol);
    if (!amt || amt <= 0) return res.status(400).json({ error: "Invalid amountSol" });

    const lamports = Math.round(amt * 1e9);
    // One /order call now returns both the quote and (with taker set) the
    // signable transaction — the old separate getQuote() + buildSwapTransaction
    // round-trip collapses into this single call under the new API.
    const { transaction } = await buildSwapTransaction({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports,
      userPublicKey: account,
      referralAccount: REFERRAL_ACCOUNT,
      referralFeeBps: PLATFORM_FEE_BPS,
      apiKey: JUPITER_API_KEY,
    });

    res.json({
      transaction,
      message: `Buy ${amt} SOL of ${token.symbol} — fee included, review the exact numbers in your wallet before approving.`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Simple price lookup, used by the Telegram bot's /price command. ---
app.get("/api/price", async (req, res) => {
  try {
    const token = findToken(req.query.mint);
    if (!token) return res.status(400).json({ error: "Unsupported token" });
    const price = await getUsdPrice(token.mint, token.decimals, JUPITER_API_KEY);
    res.json({ symbol: token.symbol, mint: token.mint, price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(new URL("./public", import.meta.url).pathname));

assertConfig();
app.listen(PORT, () => {
  console.log(`Actions API + trade page listening on :${PORT}`);
  console.log(`Once deployed publicly, Blinks live at: ${PUBLIC_BASE_URL || "(set PUBLIC_BASE_URL first)"}/buy?mint=<TOKEN_MINT>`);
});
