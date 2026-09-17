import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { getOrder, executeOrder } from "./server/jupiter.mjs";
import { resolveToken, publicToken, looksLikeMint, SOL_MINT, USDC_MINT } from "./lib/tokens.mjs";
import { createTelegram } from "./lib/telegram.mjs";
import { createStore } from "./lib/store.mjs";
import { createHandlers, tradeNotice } from "./bot/handlers.mjs";

/**
 * Clearlane Terminal — one process for everything (Sept 17, 2026).
 *
 * Serves the trade page, the order/execute relay, the Blinks endpoints and
 * the Telegram bot (via webhook). Previously the bot long-polled Telegram
 * from a separate Render free service; Render's free plan spins a service
 * down after ~15 minutes without *incoming* HTTP traffic, and outgoing
 * polling doesn't count, so the bot went silent between visits. With a
 * webhook, each Telegram message is an incoming request that wakes the
 * service, and a light self-ping keeps it warm.
 *
 * Non-custodial throughout: /api/execute only relays a transaction the
 * user already signed in their own wallet to Jupiter. We never hold keys.
 */

const env = process.env;
const PORT = Number(env.PORT || 3000);
// Render sets RENDER_EXTERNAL_URL to this service's own public URL.
const BASE_URL = (env.RENDER_EXTERNAL_URL || env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const FEE_BPS = Number(env.PLATFORM_FEE_BPS || 50);
// Public key of Idea 3's Jupiter Ultra referral account (not a secret).
const REFERRAL_ACCOUNT = env.REFERRAL_ACCOUNT || "9nv5SVUdZ5sSCk6zPHtRQLqJfxWxx3pvGmwF11frFhY3";
const JUPITER_API_KEY = env.JUPITER_API_KEY || "";
const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN.startsWith("REPLACE_") ? env.TELEGRAM_BOT_TOKEN : "";
const ADMIN_CHAT_ID = env.ADMIN_CHAT_ID || "";
const REF_SHARE_PCT = Number(env.REF_SHARE_PCT || 30);
const JUPITER_CUT_PCT = Number(env.JUPITER_CUT_PCT || 20);
const KEEPALIVE = (env.KEEPALIVE || "true") !== "false";

const tg = BOT_TOKEN ? createTelegram(BOT_TOKEN) : null;
const store = createStore({ tg, adminChatId: ADMIN_CHAT_ID, feeBps: FEE_BPS, jupiterCutPct: JUPITER_CUT_PCT, refSharePct: REF_SHARE_PCT });
const WEBHOOK_SECRET = BOT_TOKEN ? crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 40) : "";
let handlers = null;

// Orders we quoted, so a successful execute can be attributed and sized.
const pendingOrders = new Map(); // requestId -> { u, usd, bps, side, mint, symbol, at }
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of pendingOrders) if (v.at < cutoff) pendingOrders.delete(k);
}, 60_000).unref();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Encoding");
  res.setHeader("X-Action-Version", "2.4");
  res.setHeader("X-Blockchain-Ids", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  next();
});
app.options("*", (req, res) => res.sendStatus(204));

app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/", (req, res) => res.redirect("/trade.html"));

// --- Token lookup for the trade page (symbol or mint). ---
app.get("/api/token", async (req, res) => {
  try {
    const t = await resolveToken(String(req.query.q || req.query.mint || ""), JUPITER_API_KEY);
    if (!t) return res.status(404).json({ error: "Token not found" });
    res.json(publicToken(t));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Back-compat for anything still calling /api/price?mint=
app.get("/api/price", async (req, res) => {
  try {
    const t = await resolveToken(String(req.query.mint || ""), JUPITER_API_KEY);
    if (!t) return res.status(404).json({ error: "Token not found" });
    res.json({ symbol: publicToken(t).symbol, mint: t.id, price: t.usdPrice });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Wallet balances (read-only, public data) for the trade page's Max button. ---
app.get("/api/holdings", async (req, res) => {
  try {
    const w = String(req.query.wallet || "");
    if (!looksLikeMint(w)) return res.status(400).json({ error: "Invalid wallet" });
    const r = await fetch(`https://api.jup.ag/swap/v2/holdings/${w}`, { headers: JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {} });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Quote/order relay: adds our referral fee server-side. ---
app.get("/api/order", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, taker, u } = req.query;
    if (!looksLikeMint(inputMint) || !looksLikeMint(outputMint)) return res.status(400).json({ error: "Invalid token" });
    if (!(Number(amount) > 0)) return res.status(400).json({ error: "Invalid amount" });
    if (taker && !looksLikeMint(taker)) return res.status(400).json({ error: "Invalid wallet" });
    const order = await getOrder({
      inputMint, outputMint, amount, taker,
      referralAccount: REFERRAL_ACCOUNT, referralFeeBps: FEE_BPS, apiKey: JUPITER_API_KEY,
    });
    if (order.requestId && taker) {
      const side = inputMint === SOL_MINT || inputMint === USDC_MINT ? "buy" : "sell";
      const tokenMint = side === "buy" ? outputMint : inputMint;
      let symbol = "";
      try { symbol = publicToken(await resolveToken(tokenMint, JUPITER_API_KEY))?.symbol || ""; } catch {}
      pendingOrders.set(order.requestId, {
        u: u && /^\d+$/.test(String(u)) ? String(u) : null,
        usd: Number(order.swapUsdValue ?? order.inUsdValue ?? 0),
        bps: Number(order.feeBps ?? 0),
        side, mint: tokenMint, symbol, at: Date.now(),
      });
    }
    res.json(order);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Execute relay: forwards the user-signed tx to Jupiter, records the trade. ---
app.post("/api/execute", async (req, res) => {
  const { requestId, signedTransaction } = req.body || {};
  if (!requestId || !signedTransaction) return res.status(400).json({ error: "Missing requestId or signedTransaction" });
  try {
    const result = await executeOrder({ requestId, signedTransaction, apiKey: JUPITER_API_KEY });
    const p = pendingOrders.get(requestId);
    pendingOrders.delete(requestId);
    if (p && result.signature) {
      const trade = store.recordTrade({ u: p.u, usd: p.usd, bps: p.bps, sig: result.signature, side: p.side, mint: p.mint, symbol: p.symbol });
      if (tg && ADMIN_CHAT_ID) {
        const user = p.u ? store.getUser(p.u) : null;
        tg.sendMessage(ADMIN_CHAT_ID, tradeNotice({ trade, userName: user?.name })).catch(() => {});
      }
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ status: "Failed", error: e.message });
  }
});

// --- Solana Actions (Blinks): buy any token with SOL. ---
app.get("/actions.json", (req, res) => {
  res.json({ rules: [{ pathPattern: "/buy", apiPath: "/api/actions/buy" }, { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" }] });
});

app.get("/api/actions/buy", async (req, res) => {
  try {
    const t = await resolveToken(String(req.query.mint || ""), JUPITER_API_KEY);
    if (!t) return res.status(400).json({ message: "Unknown token" });
    const p = publicToken(t);
    const m = t.id;
    res.json({
      type: "action",
      icon: p.icon || `${BASE_URL}/icon.png`,
      title: `Buy ${p.symbol}`,
      label: `Buy ${p.symbol}`,
      description: `Non-custodial buy of ${p.symbol} via Jupiter. You sign in your own wallet. A ${(FEE_BPS / 100).toFixed(2)}% fee is included and shown before you approve.${p.flags.length ? " Warnings: " + p.flags.join("; ") + "." : ""}`,
      links: {
        actions: [
          { type: "transaction", label: "0.1 SOL", href: `/api/actions/buy?mint=${m}&amountSol=0.1` },
          { type: "transaction", label: "0.5 SOL", href: `/api/actions/buy?mint=${m}&amountSol=0.5` },
          { type: "transaction", label: "1 SOL", href: `/api/actions/buy?mint=${m}&amountSol=1` },
          { type: "transaction", label: "Buy", href: `/api/actions/buy?mint=${m}&amountSol={amount}`, parameters: [{ name: "amount", label: "Amount in SOL" }] },
        ],
      },
    });
  } catch (e) {
    res.status(502).json({ message: e.message });
  }
});

app.post("/api/actions/buy", async (req, res) => {
  try {
    const { mint, amountSol } = req.query;
    const { account } = req.body || {};
    if (!looksLikeMint(mint)) return res.status(400).json({ message: "Invalid token" });
    if (!looksLikeMint(account)) return res.status(400).json({ message: "Missing wallet" });
    const amt = Number(amountSol);
    if (!(amt > 0)) return res.status(400).json({ message: "Invalid amount" });
    const order = await getOrder({
      inputMint: SOL_MINT, outputMint: mint, amount: Math.round(amt * 1e9), taker: account,
      referralAccount: REFERRAL_ACCOUNT, referralFeeBps: FEE_BPS, apiKey: JUPITER_API_KEY,
    });
    if (!order.transaction) return res.status(400).json({ message: "No route for this trade right now — try a smaller amount." });
    res.json({ type: "transaction", transaction: order.transaction, message: `Buying with ${amt} SOL — review the exact amounts in your wallet before approving.` });
  } catch (e) {
    res.status(502).json({ message: e.message });
  }
});

// --- Telegram webhook ---
if (tg) {
  app.post(`/tg/${WEBHOOK_SECRET}`, (req, res) => {
    if (req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) return res.sendStatus(401);
    res.sendStatus(200); // ack fast; Telegram retries slow responses
    const msg = req.body?.message;
    if (msg && handlers) handlers.handleMessage(msg).catch((e) => console.error("handleMessage:", e.message));
  });
}

app.use(express.static(new URL("./server/public", import.meta.url).pathname));

async function startBot() {
  if (!tg) {
    console.log("TELEGRAM_BOT_TOKEN not set — running web + API only (no bot).");
    return;
  }
  const me = await tg.call("getMe");
  await store.load();
  handlers = createHandlers({
    tg, store, baseUrl: BASE_URL, botUsername: me.username, adminChatId: ADMIN_CHAT_ID,
    apiKey: JUPITER_API_KEY, feeBps: FEE_BPS, refSharePct: REF_SHARE_PCT, jupiterCutPct: JUPITER_CUT_PCT,
  });

  if (BASE_URL.startsWith("https://")) {
    await tg.call("setWebhook", {
      url: `${BASE_URL}/tg/${WEBHOOK_SECRET}`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    console.log(`Bot @${me.username} receiving updates via webhook at ${BASE_URL}/tg/…`);
  } else {
    // Local development: long-poll instead.
    await tg.call("deleteWebhook", {});
    console.log(`Bot @${me.username} long-polling (local mode).`);
    let offset = 0;
    (async () => {
      for (;;) {
        try {
          const updates = await tg.call("getUpdates", { timeout: 30, offset });
          for (const u of updates) {
            offset = u.update_id + 1;
            if (u.message) await handlers.handleMessage(u.message).catch((e) => console.error(e.message));
          }
        } catch (e) {
          console.error("poll:", e.message);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
  }

  await tg.call("setMyCommands", {
    commands: [
      { command: "buy", description: "Buy any token: /buy BONK 0.5" },
      { command: "sell", description: "Sell a token for SOL: /sell WIF" },
      { command: "price", description: "Price and safety check: /price JUP" },
      { command: "ref", description: "Your invite link — earn from referrals" },
      { command: "wallet", description: "Set your payout wallet" },
      { command: "help", description: "How it works" },
    ],
  }).catch((e) => console.error("setMyCommands:", e.message));
  await tg.call("setMyShortDescription", {
    short_description: "Trade any Solana token from Telegram. Non-custodial — you sign every trade. Fee shown up front.",
  }).catch(() => {});
}

app.listen(PORT, async () => {
  console.log(`Clearlane Terminal listening on :${PORT} (public URL: ${BASE_URL})`);
  try {
    await startBot();
  } catch (e) {
    console.error("Bot startup failed:", e.message);
  }
  if (KEEPALIVE && BASE_URL.startsWith("https://") && tg) {
    setInterval(() => fetch(`${BASE_URL}/healthz`).catch(() => {}), 10 * 60_000).unref();
    console.log("Keep-alive ping every 10 minutes.");
  }
});
