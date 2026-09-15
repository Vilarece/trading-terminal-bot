import "dotenv/config";
import http from "node:http";

/**
 * The Telegram half of the terminal: command handling and messaging only.
 * It never builds or signs a transaction itself — every /buy reply is just
 * a link to the Actions API or the trade page (server/index.mjs), so this
 * process could leak its bot token and still not put a single user's funds
 * at risk. That split is deliberate, not incidental.
 *
 * Raw long-polling via Telegram's Bot API (no SDK dependency) — same style
 * as Idea 2's telegram.mjs, kept consistent across this project.
 *
 * Sept 15, 2026: Render's free tier no longer offers the "background
 * worker" service type (paid plans only) — render.yaml now deploys this as
 * a free "web service" instead, which just means Render expects something
 * listening on PORT for its health checks. The tiny HTTP server below is
 * only that: a 200 OK stub. The actual bot logic below is unchanged and
 * still just long-polls Telegram in the same process.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SUPPORTED_TOKENS = JSON.parse(process.env.SUPPORTED_TOKENS_JSON || "[]");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PORT = Number(process.env.PORT || 10000);

function assertConfig() {
  const missing = [];
  if (!BOT_TOKEN || BOT_TOKEN.startsWith("REPLACE_")) missing.push("TELEGRAM_BOT_TOKEN");
  if (!PUBLIC_BASE_URL || PUBLIC_BASE_URL.includes("REPLACE_")) missing.push("PUBLIC_BASE_URL");
  if (missing.length) {
    console.error(`Missing/placeholder .env values: ${missing.join(", ")}`);
    console.error("This bot needs the Actions server (server/index.mjs) already deployed and PUBLIC_BASE_URL pointed at it.");
    process.exit(1);
  }
}

// --- Health-check stub so Render's free "web service" plan is happy. ---
// Not part of the bot's actual functionality — just keeps the platform's
// port-binding requirement satisfied while the long-poll loop below runs.
function startHealthServer() {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Terminal bot is running (Telegram long-polling, not HTTP).");
    })
    .listen(PORT, () => {
      console.log(`Health-check stub listening on :${PORT} (Render web-service requirement only).`);
    });
}

let offset = 0;

async function getUpdates() {
  const res = await fetch(`${TELEGRAM_API}/getUpdates?timeout=30&offset=${offset}`);
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

async function sendMessage(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) console.error("sendMessage failed:", await res.text());
}

function findToken(query) {
  const q = (query || "").trim();
  return SUPPORTED_TOKENS.find(
    (t) => t.symbol.toUpperCase() === q.toUpperCase() || t.mint === q
  );
}

const HELP_TEXT = [
  "*Non-custodial trading terminal*",
  "",
  "We never hold your wallet. Every /buy reply is a link — you open it in " +
    "your own wallet (or a real browser tab) and sign there. This bot never " +
    "sees a private key.",
  "",
  "*Commands*",
  "`/buy SYMBOL AMOUNT` — e.g. `/buy BONK 0.5` (amount in SOL)",
  "`/price SYMBOL` — current USD price",
  "`/tokens` — list what's supported right now",
  "",
  "Why a link instead of a button that trades instantly? Because instant, " +
    "in-chat trading is exactly what the custodial bots (Trojan, Photon, " +
    "BullX, etc.) offer — by holding your wallet for you. One extra tap is " +
    "the price of never handing over that control.",
].join("\n");

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/help") {
    return sendMessage(chatId, HELP_TEXT);
  }

  if (text === "/tokens") {
    const list = SUPPORTED_TOKENS.length
      ? SUPPORTED_TOKENS.map((t) => `• ${t.symbol}`).join("\n")
      : "(none configured yet — add tokens to SUPPORTED_TOKENS_JSON in .env)";
    return sendMessage(chatId, `*Supported tokens:*\n${list}`);
  }

  if (text.startsWith("/buy")) {
    const parts = text.split(/\s+/);
    const token = findToken(parts[1]);
    const amount = Number(parts[2]);
    if (!token || !amount || amount <= 0) {
      return sendMessage(
        chatId,
        "Usage: `/buy SYMBOL AMOUNT` — e.g. `/buy BONK 0.5`. Run /tokens to see what's supported."
      );
    }
    const blinkUrl = `${PUBLIC_BASE_URL}/buy?mint=${token.mint}`;
    const tradePageUrl = `${PUBLIC_BASE_URL}/trade.html?output=${token.mint}&amount=${amount}`;
    return sendMessage(
      chatId,
      [
        `*Buy ${amount} SOL of ${token.symbol}*`,
        "",
        "Pick whichever works with your wallet — both are non-custodial:",
        "",
        `1) *Blink* (opens directly in Phantom/Backpack or any Blinks-aware wallet):`,
        blinkUrl,
        "",
        `2) *Trade page* (connect your wallet in a normal browser tab):`,
        tradePageUrl,
        "",
        "Either way, review the exact fee + amount in your own wallet before approving — nothing is pre-signed.",
      ].join("\n")
    );
  }

  if (text.startsWith("/price")) {
    const token = findToken(text.split(/\s+/)[1]);
    if (!token) {
      return sendMessage(chatId, "Usage: `/price SYMBOL`. Run /tokens to see what's supported.");
    }
    try {
      const res = await fetch(`${PUBLIC_BASE_URL}/api/price?mint=${token.mint}`);
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const data = await res.json();
      return sendMessage(chatId, `*${token.symbol}*: $${Number(data.price).toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
    } catch (e) {
      return sendMessage(chatId, `Couldn't fetch price right now (${e.message}). Try again shortly.`);
    }
  }

  // Unrecognized input — gently redirect rather than staying silent.
  return sendMessage(chatId, "Not sure what that means — try /help.");
}

async function loop() {
  console.log("Terminal bot polling started.");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await getUpdates();
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          await handleMessage(u.message).catch((e) => console.error("handleMessage error:", e.message));
        }
      }
    } catch (e) {
      console.error("Poll error:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

assertConfig();
startHealthServer();
loop();
