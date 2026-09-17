/**
 * Server-side Jupiter quote + unsigned-transaction builder.
 *
 * Migrated Sept 11, 2026 off the dead quote-api.jup.ag/v6 API (deprecated
 * Oct 1, 2025) to api.jup.ag/swap/v2 — the same migration Idea 1's widget
 * got on Sept 9. See fee-router-widget/index.html for the client-side
 * twin of this logic (order -> sign -> execute), proven live with two real
 * mainnet swaps.
 *
 * Two things changed from the old v6 quote+swap pair:
 *   1. "quote" + "swap" became one call: GET /order (returns a quote AND,
 *      when a `taker` pubkey is passed, an unsigned transaction).
 *   2. Jupiter's Referral Program now enforces a 50bps *minimum* referral
 *      fee (was 20bps) — PLATFORM_FEE_BPS default bumped in index.mjs/.env.
 *
 * IMPORTANT — unresolved open question, read before wider release:
 * Idea 1's widget signs the /order transaction AND submits it itself via
 * POST /execute (Jupiter's own relay — see executeOrder() below and
 * fee-router-widget/index.html's swapBtn handler). That works because the
 * widget controls both the signing step and the submission step.
 *
 * This file is used by server/index.mjs's Solana Actions ("Blinks") route,
 * where the roles are split differently: OUR server only returns an
 * unsigned transaction in the POST response; a third-party Blink client
 * (Phantom, Backpack, dial.to, etc.) has the user sign it and then THAT
 * CLIENT — not us — submits it, almost certainly via a plain Solana RPC
 * call, not by calling Jupiter's /execute. Jupiter's own docs describe
 * /execute as required "landing" infrastructure for /order transactions
 * (retries, priority handling, requestId-based status tracking) and
 * explicitly contrast it with a separate /build endpoint that returns raw,
 * unsigned instructions specifically meant for self-broadcast via your own
 * RPC (see https://developers.jup.ag/docs/swap/build). Whether an /order
 * transaction ALSO lands fine via plain self-broadcast (skipping /execute
 * entirely) is not clearly documented either way.
 *
 * Translation: this migration keeps the same /order call Idea 1 uses
 * because it's the simplest, most-proven path, but the Blinks flow has
 * NOT been proven to actually land on-chain the way Idea 1's widget has.
 * Per the project's own non-negotiable testing rule, do not treat this as
 * "done" until you've run server/index.mjs's step 2 (curl the Actions API)
 * AND actually opened a real /buy Blink in Phantom/Backpack with a small
 * amount and confirmed the resulting transaction lands on Solscan. If it
 * doesn't land, the fix is switching this file to /build instead of
 * /order — more work (you assemble the instructions into a transaction
 * yourself), but that endpoint is purpose-built for exactly this
 * "someone else submits it" case.
 */

const JUPITER_API = "https://api.jup.ag/swap/v2";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

function jupiterHeaders(apiKey) {
  return apiKey ? { "x-api-key": apiKey } : {};
}

/**
 * GET /order — replaces the old /quote + /swap pair.
 * Without `taker`, returns a quote only (transaction: null) — good for
 * price lookups (getUsdPrice below). With `taker`, also returns an
 * unsigned, base64-encoded transaction ready to hand to a wallet to sign.
 */
export async function getOrder({ inputMint, outputMint, amount, slippageBps, referralAccount, referralFeeBps, taker, apiKey }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
  });
  // Sept 17, 2026: only pass slippage when explicitly asked. Left unset,
  // Jupiter Ultra picks slippage automatically, which matters for volatile
  // memecoins where a fixed 0.5% makes many trades fail.
  if (slippageBps != null) params.set("slippageBps", String(slippageBps));
  if (referralAccount && referralFeeBps) {
    params.set("referralAccount", referralAccount);
    params.set("referralFee", String(referralFeeBps));
  }
  if (taker) params.set("taker", taker);

  const res = await fetch(`${JUPITER_API}/order?${params.toString()}`, {
    headers: jupiterHeaders(apiKey),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Jupiter order failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Back-compat shim for callers written against the old getQuote() name —
 * same signature shape server/index.mjs already used, mapped onto the new
 * /order call. platformFeeBps here maps to referralFee (see getOrder).
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps, platformFeeBps, referralAccount, apiKey }) {
  return getOrder({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    referralAccount,
    referralFeeBps: platformFeeBps,
    apiKey,
  });
}

/**
 * Builds the unsigned transaction for a given taker by re-requesting the
 * order with `taker` set (the /order response only includes a signable
 * transaction when a taker pubkey is provided). Returns the base64 string,
 * same shape the old buildSwapTransaction() returned, so server/index.mjs's
 * POST /api/actions/buy handler needs minimal changes.
 *
 * NOTE: unlike the old v6 /swap call, there is no separate feeAccount
 * parameter — the referral fee account is derived automatically from
 * REFERRAL_ACCOUNT + the output mint (same as Idea 1; see that widget's
 * README for how Referral Token Accounts are created per output mint at
 * referral.jup.ag).
 */
export async function buildSwapTransaction({ inputMint, outputMint, amount, slippageBps, userPublicKey, referralAccount, referralFeeBps, apiKey }) {
  const order = await getOrder({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    referralAccount,
    referralFeeBps,
    taker: userPublicKey,
    apiKey,
  });
  if (!order.transaction) {
    throw new Error("Jupiter returned no signable transaction for this route — try a smaller amount or a different pair.");
  }
  return { transaction: order.transaction, requestId: order.requestId };
}

/**
 * POST /execute — submits a signed transaction via Jupiter's own relay.
 * Only meaningful when you (like Idea 1's client-side widget) control the
 * signing step yourself. See the file-level comment above: the Actions/
 * Blinks route in server/index.mjs currently does NOT call this, because
 * the signing happens in a third-party client we don't control. Exported
 * here for completeness and for any future flow (e.g. a custodial-adjacent
 * "sign here" web view) that does control both steps.
 */
export async function executeOrder({ requestId, signedTransaction, apiKey }) {
  const res = await fetch(`${JUPITER_API}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jupiterHeaders(apiKey) },
    body: JSON.stringify({ requestId, signedTransaction }),
  });
  const result = await res.json().catch(() => ({}));
  if (result.status !== "Success") {
    throw new Error(result.error || `Execute failed (${res.status}).`);
  }
  return result;
}

/** USD price of 1 unit of `mint`, quoted against USDC. Used for /price. */
export async function getUsdPrice(mint, decimals, apiKey) {
  if (mint === USDC_MINT) return 1;
  const order = await getOrder({
    inputMint: mint,
    outputMint: USDC_MINT,
    amount: 10 ** decimals,
    apiKey,
  });
  return Number(order.outAmount) / 10 ** 6;
}
