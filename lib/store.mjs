/**
 * Referral + trade ledger (Sept 17, 2026).
 *
 * Render's free plan has no persistent disk and restarts/spins down often,
 * so state is kept in memory and backed up as a JSON file pinned in the
 * admin's private chat with the bot (ADMIN_CHAT_ID). On startup the bot
 * reads the pinned file back. No extra accounts or databases needed.
 * If ADMIN_CHAT_ID isn't set, everything still works but resets on restart.
 *
 * Economics (defaults, all env-configurable):
 *   PLATFORM_FEE_BPS = 50      -> 0.50% fee on each trade
 *   JUPITER_CUT_PCT  = 20      -> Jupiter keeps 20% of that fee
 *   REF_SHARE_PCT    = 30      -> referrer earns 30% of what WE keep
 * So a referrer earns 0.12% of every trade their referrals make.
 */

const MAX_TRADES = 3000;

export function createStore({ tg, adminChatId, feeBps, jupiterCutPct, refSharePct }) {
  let state = { v: 1, users: {}, trades: [], paid: {} };
  let saveTimer = null;
  let lastDocMessageId = null;

  const netFeeUsd = (usd, bps = feeBps) => usd * (bps / 10_000) * (1 - jupiterCutPct / 100);

  async function load() {
    if (!tg || !adminChatId) {
      console.warn("Store: ADMIN_CHAT_ID not set — referral data will reset whenever the service restarts.");
      return;
    }
    try {
      const chat = await tg.call("getChat", { chat_id: adminChatId });
      const pinned = chat.pinned_message;
      if (pinned?.document && pinned.document.file_name?.startsWith("clearlane-ledger")) {
        const text = await tg.downloadFile(pinned.document.file_id);
        const parsed = JSON.parse(text);
        if (parsed && parsed.v === 1) state = { paid: {}, ...parsed };
        lastDocMessageId = pinned.message_id;
        console.log(`Store: loaded ${Object.keys(state.users).length} users, ${state.trades.length} trades from pinned backup.`);
      } else {
        console.log("Store: no pinned backup found — starting fresh.");
      }
    } catch (e) {
      console.error("Store: load failed, starting fresh:", e.message);
    }
  }

  function scheduleSave() {
    if (!tg || !adminChatId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 5000);
  }

  async function save() {
    try {
      const body = JSON.stringify(state);
      const msg = await tg.sendDocument(adminChatId, `clearlane-ledger-${Date.now()}.json`, body, "Clearlane ledger backup (auto). Keep pinned.");
      await tg.call("pinChatMessage", { chat_id: adminChatId, message_id: msg.message_id, disable_notification: true });
      if (lastDocMessageId) {
        await tg.call("deleteMessage", { chat_id: adminChatId, message_id: lastDocMessageId }).catch(() => {});
      }
      lastDocMessageId = msg.message_id;
    } catch (e) {
      console.error("Store: save failed:", e.message);
    }
  }

  function getUser(id) {
    return state.users[String(id)] || null;
  }

  function touchUser(from) {
    const id = String(from.id);
    const u = state.users[id] || { ref: null, joined: Date.now(), wallet: null };
    u.name = from.username ? `@${from.username}` : (from.first_name || "user");
    state.users[id] = u;
    return u;
  }

  /** First-touch attribution; can't refer yourself; can't be changed later. */
  function setReferrer(userId, referrerId) {
    const u = state.users[String(userId)];
    if (!u || u.ref || String(userId) === String(referrerId)) return false;
    if (!state.users[String(referrerId)]) return false;
    u.ref = String(referrerId);
    scheduleSave();
    return true;
  }

  function setWallet(userId, wallet) {
    const u = state.users[String(userId)];
    if (!u) return;
    u.wallet = wallet;
    scheduleSave();
  }

  function recordTrade({ u, usd, bps, sig, side, mint, symbol }) {
    const user = u ? state.users[String(u)] : null;
    const ref = user?.ref || null;
    const net = netFeeUsd(usd, bps);
    const trade = { t: Date.now(), u: u ? String(u) : null, ref, usd, bps, net, refUsd: ref ? net * (refSharePct / 100) : 0, sig, side, mint, symbol };
    state.trades.push(trade);
    if (state.trades.length > MAX_TRADES) state.trades.splice(0, state.trades.length - MAX_TRADES);
    scheduleSave();
    return trade;
  }

  function referrerStats(refId) {
    const id = String(refId);
    const referred = Object.values(state.users).filter((x) => x.ref === id).length;
    const trades = state.trades.filter((t) => t.ref === id);
    const volume = trades.reduce((s, t) => s + t.usd, 0);
    const earned = trades.reduce((s, t) => s + t.refUsd, 0);
    const paid = state.paid[id] || 0;
    return { referred, trades: trades.length, volume, earned, paid, owed: Math.max(earned - paid, 0) };
  }

  function totals() {
    const volume = state.trades.reduce((s, t) => s + t.usd, 0);
    const net = state.trades.reduce((s, t) => s + t.net, 0);
    const refOwed = Object.keys(state.users).reduce((s, id) => s + referrerStats(id).owed, 0);
    return { users: Object.keys(state.users).length, trades: state.trades.length, volume, net, refOwed };
  }

  function payoutList(minUsd = 0) {
    return Object.entries(state.users)
      .map(([id, u]) => ({ id, name: u.name, wallet: u.wallet, ...referrerStats(id) }))
      .filter((r) => r.owed > minUsd)
      .sort((a, b) => b.owed - a.owed);
  }

  function markPaid(refId, usd) {
    const id = String(refId);
    state.paid[id] = (state.paid[id] || 0) + usd;
    scheduleSave();
  }

  return { load, save, getUser, touchUser, setReferrer, setWallet, recordTrade, referrerStats, totals, payoutList, markPaid, netFeeUsd };
}
