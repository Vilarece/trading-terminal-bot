/**
 * Telegram command handling (Sept 17, 2026 rewrite).
 *
 * - Trade ANY Solana token: /buy and /sell take a symbol or a pasted mint,
 *   and pasting a bare mint address shows a token card with buy buttons.
 * - Every trade card shows plain-language risk flags before any link.
 * - Referral program: /ref gives a personal invite link; referrers earn a
 *   share of the fees their referrals generate (see lib/store.mjs).
 * - Buttons open the trade page directly inside Phantom or Solflare on
 *   mobile (their in-app browsers have the wallet built in), which fixes
 *   the "no wallet found in Telegram's browser" dead end.
 *
 * Still non-custodial: the bot only ever sends links. Signing happens in the
 * user's own wallet on the trade page.
 */

import { resolveToken, looksLikeMint, publicToken, fmtUsd, fmtPrice, SOL_MINT } from "../lib/tokens.mjs";
import { esc } from "../lib/telegram.mjs";

const BUY_PRESETS = [0.1, 0.25, 0.5, 1];

export function createHandlers({ tg, store, baseUrl, botUsername, adminChatId, apiKey, feeBps, refSharePct, jupiterCutPct }) {
  const isAdmin = (msg) => adminChatId && String(msg.chat.id) === String(adminChatId);
  const refPctOfVolume = ((feeBps / 100) * (1 - jupiterCutPct / 100) * (refSharePct / 100)).toFixed(2);

  function tradeUrl({ input, output, amount, userId }) {
    const p = new URLSearchParams();
    if (input) p.set("input", input);
    if (output) p.set("output", output);
    if (amount) p.set("amount", String(amount));
    if (userId) p.set("u", String(userId));
    return `${baseUrl}/trade.html?${p.toString()}`;
  }

  const phantomLink = (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(baseUrl)}`;
  const solflareLink = (url) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(baseUrl)}`;

  function walletRows(url, label) {
    return [
      [{ text: `👻 ${label} in Phantom`, url: phantomLink(url) }, { text: `🔥 ${label} in Solflare`, url: solflareLink(url) }],
      [{ text: `🌐 ${label} in browser`, url }],
    ];
  }

  function tokenCard(t) {
    const p = publicToken(t);
    const lines = [
      `<b>${esc(p.symbol)}</b> · ${esc(p.name)} ${p.verified ? "✅" : "⚠️"}`,
      `<code>${esc(p.mint)}</code>`,
      "",
      `Price: <b>$${fmtPrice(p.usdPrice)}</b>${p.change24h != null ? ` (${p.change24h >= 0 ? "+" : ""}${p.change24h.toFixed(1)}% 24h)` : ""}`,
      `Market cap: ${p.mcap ? "$" + fmtUsd(p.mcap) : "—"} · Liquidity: ${p.liquidity != null ? "$" + fmtUsd(p.liquidity) : "—"}`,
      p.holders != null ? `Holders: ${Number(p.holders).toLocaleString("en-US")}` : null,
    ].filter((x) => x !== null);
    if (p.flags.length) {
      lines.push("", "<b>⚠️ Check before buying:</b>", ...p.flags.map((f) => `• ${esc(f)}`));
    }
    return lines.join("\n");
  }

  async function sendBuyCard(chatId, userId, t, amount) {
    const text = [
      tokenCard(t),
      "",
      amount
        ? `Tap to buy <b>${amount} SOL</b> of ${esc(publicToken(t).symbol)}. You'll see the exact amount and our ${(feeBps / 100).toFixed(2)}% fee in your wallet before you sign.`
        : `Pick an amount. You'll see the exact amount and our ${(feeBps / 100).toFixed(2)}% fee in your wallet before you sign.`,
    ].join("\n");
    let keyboard;
    if (amount) {
      keyboard = walletRows(tradeUrl({ input: SOL_MINT, output: t.id, amount, userId }), `Buy ${amount} SOL`);
    } else {
      // Plain trade-page links work on desktop and mobile; the page itself
      // offers "open in Phantom/Solflare" when no wallet is detected.
      const presetRow = BUY_PRESETS.map((a) => ({ text: `${a} SOL`, url: tradeUrl({ input: SOL_MINT, output: t.id, amount: a, userId }) }));
      const anyAmount = tradeUrl({ input: SOL_MINT, output: t.id, userId });
      keyboard = [
        presetRow,
        [{ text: "👻 Open in Phantom", url: phantomLink(anyAmount) }, { text: "🔥 Open in Solflare", url: solflareLink(anyAmount) }],
      ];
    }
    keyboard.push([{ text: "📊 Chart", url: `https://jup.ag/tokens/${t.id}` }]);
    return tg.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendSellCard(chatId, userId, t, amount) {
    const p = publicToken(t);
    const url = tradeUrl({ input: t.id, output: SOL_MINT, amount, userId });
    const text = [
      `<b>Sell ${amount ? `${amount} ` : ""}${esc(p.symbol)} for SOL</b>`,
      `Price: $${fmtPrice(p.usdPrice)} · Liquidity: $${fmtUsd(p.liquidity)}`,
      "",
      amount ? "Tap to open the trade page with this amount filled in." : "Tap to open the trade page, then enter how much to sell (or tap Max).",
      `Our ${(feeBps / 100).toFixed(2)}% fee is shown before you sign.`,
    ].join("\n");
    return tg.sendMessage(chatId, text, { reply_markup: { inline_keyboard: walletRows(url, "Sell") } });
  }

  const HELP = () =>
    [
      "<b>Clearlane Terminal</b> — trade any Solana token without handing over your wallet.",
      "",
      "<b>Trade</b>",
      "• Paste any token address to see it and buy",
      "• <code>/buy BONK</code> or <code>/buy BONK 0.5</code> (amount in SOL)",
      "• <code>/sell WIF</code> or <code>/sell WIF 1000</code>",
      "• <code>/price JUP</code>",
      "",
      "<b>Earn</b>",
      `• <code>/ref</code> — your invite link. Earn ${refPctOfVolume}% of every trade your invites make, paid in SOL.`,
      "• <code>/wallet ADDRESS</code> — where to send your earnings",
      "",
      "<b>How it works</b>",
      `Every trade is signed in your own wallet (Phantom, Solflare). We never see your keys. Fee: ${(feeBps / 100).toFixed(2)}%, always shown before you sign. Routed through Jupiter for the best price.`,
      "",
      "Not financial advice. New tokens are high-risk — check the warnings on each card.",
    ].join("\n");

  async function resolveOrExplain(chatId, query) {
    if (!query) return null;
    let t = null;
    try {
      t = await resolveToken(query, apiKey);
    } catch (e) {
      await tg.sendMessage(chatId, `Token lookup is having trouble right now (${esc(e.message)}). Try again in a moment.`);
      return null;
    }
    if (!t) {
      await tg.sendMessage(chatId, `Couldn't find a token for <code>${esc(query)}</code>. Try pasting its contract address.`);
      return null;
    }
    return t;
  }

  function parseAmount(s) {
    if (s == null) return null;
    const n = Number(String(s).replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from || { id: chatId };
    const text = (msg.text || "").trim();
    if (!text) return;
    store.touchUser(from);

    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");

    if (cmd === "/start") {
      const payload = args[0] || "";
      let welcomeExtra = "";
      if (payload.startsWith("ref_")) {
        const refId = payload.slice(4);
        if (store.setReferrer(from.id, refId)) welcomeExtra = "\n\n👋 You joined through a friend's invite.";
      } else if (looksLikeMint(payload)) {
        await tg.sendMessage(chatId, HELP() + welcomeExtra);
        const t = await resolveOrExplain(chatId, payload);
        if (t) await sendBuyCard(chatId, from.id, t, null);
        return;
      }
      return tg.sendMessage(chatId, HELP() + welcomeExtra);
    }

    if (cmd === "/help") return tg.sendMessage(chatId, HELP());

    if (cmd === "/whoami") return tg.sendMessage(chatId, `Your chat id: <code>${chatId}</code>`);

    if (cmd === "/buy") {
      if (!args[0]) return tg.sendMessage(chatId, "Usage: <code>/buy TOKEN [SOL amount]</code> — e.g. <code>/buy BONK 0.5</code>, or just paste a token address.");
      const amount = parseAmount(args[1]);
      if (Number.isNaN(amount)) return tg.sendMessage(chatId, "That amount doesn't look right. Example: <code>/buy BONK 0.5</code>");
      const t = await resolveOrExplain(chatId, args[0]);
      if (!t) return;
      if (t.id === SOL_MINT) return tg.sendMessage(chatId, "You pay in SOL, so pick a different token to buy.");
      return sendBuyCard(chatId, from.id, t, amount);
    }

    if (cmd === "/sell") {
      if (!args[0]) return tg.sendMessage(chatId, "Usage: <code>/sell TOKEN [amount]</code> — e.g. <code>/sell WIF 1000</code>");
      const amount = parseAmount(args[1]);
      if (Number.isNaN(amount)) return tg.sendMessage(chatId, "That amount doesn't look right. Example: <code>/sell WIF 1000</code>");
      const t = await resolveOrExplain(chatId, args[0]);
      if (!t) return;
      if (t.id === SOL_MINT) return tg.sendMessage(chatId, "Sells go into SOL, so pick the token you want to sell.");
      return sendSellCard(chatId, from.id, t, amount);
    }

    if (cmd === "/price") {
      const t = await resolveOrExplain(chatId, args[0]);
      if (!t) return args[0] ? undefined : tg.sendMessage(chatId, "Usage: <code>/price TOKEN</code>");
      return tg.sendMessage(chatId, tokenCard(t), {
        reply_markup: { inline_keyboard: [[{ text: `Buy ${publicToken(t).symbol}`, url: tradeUrl({ input: SOL_MINT, output: t.id, userId: from.id }) }]] },
      });
    }

    if (cmd === "/ref" || cmd === "/invite" || cmd === "/earn") {
      const s = store.referrerStats(from.id);
      const link = `https://t.me/${botUsername}?start=ref_${from.id}`;
      const u = store.getUser(from.id);
      return tg.sendMessage(
        chatId,
        [
          "<b>Invite traders, earn SOL</b>",
          "",
          `You earn <b>${refPctOfVolume}%</b> of every trade made by people who join with your link — for as long as they trade.`,
          "",
          `Your link:\n${link}`,
          "",
          `Invited: <b>${s.referred}</b> · Their trades: <b>${s.trades}</b> · Volume: <b>$${fmtUsd(s.volume)}</b>`,
          `Earned: <b>$${s.earned.toFixed(2)}</b> · Paid: $${s.paid.toFixed(2)} · Owed: <b>$${s.owed.toFixed(2)}</b>`,
          "",
          u?.wallet ? `Payout wallet: <code>${esc(u.wallet)}</code>` : "⚠️ Set your payout wallet: <code>/wallet YOUR_SOLANA_ADDRESS</code>",
          "Payouts are sent in SOL once you're owed $5 or more.",
        ].join("\n"),
        { reply_markup: { inline_keyboard: [[{ text: "📤 Share your link", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Trade any Solana token from Telegram — non-custodial, fee shown before you sign.")}` }]] } }
      );
    }

    if (cmd === "/wallet") {
      const addr = args[0];
      if (!addr || !looksLikeMint(addr)) return tg.sendMessage(chatId, "Usage: <code>/wallet YOUR_SOLANA_ADDRESS</code> — this is only where referral earnings are sent. Never share your seed phrase with anyone.");
      store.setWallet(from.id, addr);
      return tg.sendMessage(chatId, `Payout wallet saved: <code>${esc(addr)}</code>`);
    }

    // --- Admin-only (the chat whose id is ADMIN_CHAT_ID) ---
    if (cmd === "/stats" && isAdmin(msg)) {
      const t = store.totals();
      return tg.sendMessage(chatId, [
        "<b>Clearlane stats</b> (since tracking started)",
        `Users: ${t.users} · Tracked trades: ${t.trades}`,
        `Volume: $${fmtUsd(t.volume)} · Our net fees: $${t.net.toFixed(2)}`,
        `Owed to referrers: $${t.refOwed.toFixed(2)}`,
      ].join("\n"));
    }

    if (cmd === "/payouts" && isAdmin(msg)) {
      const list = store.payoutList(0);
      if (!list.length) return tg.sendMessage(chatId, "No referral earnings owed yet.");
      return tg.sendMessage(chatId, [
        "<b>Referral payouts owed</b> (send manually, then record with /paid ID USD)",
        ...list.map((r) => `• ${esc(r.name)} (id <code>${r.id}</code>): <b>$${r.owed.toFixed(2)}</b> → ${r.wallet ? `<code>${esc(r.wallet)}</code>` : "no wallet set"}`),
      ].join("\n"));
    }

    if (cmd === "/paid" && isAdmin(msg)) {
      const [id, usdStr] = args;
      const usd = Number(usdStr);
      if (!id || !(usd > 0)) return tg.sendMessage(chatId, "Usage: <code>/paid USER_ID USD</code>");
      store.markPaid(id, usd);
      return tg.sendMessage(chatId, `Recorded $${usd.toFixed(2)} paid to ${id}.`);
    }

    // Bare token address (or $TICKER) pasted into chat -> token card.
    const bare = text.replace(/^\$/, "");
    if (looksLikeMint(text) || (/^\$[A-Za-z0-9]{2,12}$/.test(text))) {
      const t = await resolveOrExplain(chatId, bare);
      if (t && t.id !== SOL_MINT) return sendBuyCard(chatId, from.id, t, null);
      return;
    }

    return tg.sendMessage(chatId, "Paste a token address to trade it, or try /help.");
  }

  return { handleMessage };
}

/** Called by the server when a tracked trade lands, to notify the admin. */
export function tradeNotice({ trade, userName }) {
  return `💸 Trade: ${trade.side} ${esc(trade.symbol || "")} $${trade.usd.toFixed(2)} by ${esc(userName || "anonymous")} → our net fee ≈ $${trade.net.toFixed(3)}${trade.ref ? ` (referrer share $${trade.refUsd.toFixed(3)})` : ""}\n<a href="https://orbmarkets.io/tx/${trade.sig}">view tx</a>`;
}
