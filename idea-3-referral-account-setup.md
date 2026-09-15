# Idea 3 — Referral Account Setup Checklist
Written Sept 11, 2026, as a companion to `trading-terminal-bot/README.md`'s
Setup section. This is the one manual step I can't do for you — it needs
your wallet signing on referral.jup.ag's actual site.

## Why this can't just reuse Idea 1's account
Confirmed during Idea 1's build: each Jupiter API product tab on
referral.jup.ag (**Referral**, **Swap + Trigger**, **Ultra**) issues a
separate Referral Account address, even for the same wallet. Idea 1's
widget and Idea 3's server both call the same `api.jup.ag/swap/v2/order`
endpoint (the "Ultra-style" API), so both need an account from the
**Ultra tab specifically** — but they need to be *different* Ultra-tab
accounts, one per product, so fees and volume don't get mixed together in
one dashboard and so a change to one product's fee settings never
accidentally touches the other.

**Open question the plan itself flagged, unresolved:** it's not confirmed
whether referral.jup.ag lets one wallet create a *second*, separately-named
account on the same tab, or whether getting a genuinely separate account
means using a second wallet. Step 2 below is where you find out — I can't
check this myself, it requires connecting a wallet to their site.

## Steps

1. **Decide which wallet.** Simplest: try your existing wallet (the one
   already used for Idea 1) first — go to step 2 and see if the Ultra tab
   offers any "create another account" / "new project" option once you
   already have one there. If it only ever shows the one existing account
   with no way to add a second, the working alternative is a **second
   Solana wallet you also control** (a new Phantom/Solflare wallet costs
   nothing to create), used only for Idea 3's referral account. Either way,
   this needs to be a wallet you hold the keys to — same non-custodial
   principle as everything else in this project.

2. **Go to [referral.jup.ag](https://referral.jup.ag), connect the wallet
   from step 1, and open the Ultra tab specifically** (not the general
   "Referral" tab — that produces an account this project's API calls
   can't use, per Idea 1's README). Create a Referral Account there.

3. **Create Referral Token Accounts** for every mint currently in
   `trading-terminal-bot/.env`'s `SUPPORTED_TOKENS_JSON` — right now that's
   USDC, JUP, and BONK. Same process as Idea 1: either the "Create Token
   Accounts" bulk button, or the per-token "•••" menu if the bulk action
   fails wallet simulation (this happened once during Idea 1's setup and
   resolved on retry — try one at a time if it recurs).

4. **Copy the resulting Referral Account pubkey into two places:**
   - `trading-terminal-bot/.env` → `REFERRAL_ACCOUNT=`
   - `trading-terminal-bot/server/public/trade.html` → `CONFIG.REFERRAL_ACCOUNT`
     (near the top of the `<script>` block)

   Do **not** paste Idea 1's existing pubkey
   (`QX6TPsKZagAv1iKteCjJtUWikVN1tNgRkXYa33GcKzL`) into either of these —
   that's the whole point of this checklist.

5. **Optional: a Jupiter API key.** Unlike the referral account, this
   should be safe to reuse — if you already got one for Idea 1 at
   [developers.jup.ag/portal](https://developers.jup.ag/portal), the same
   key works here too (it's a rate-limit credential tied to your developer
   account, not to a specific referral account). Paste it into
   `trading-terminal-bot/.env` → `JUPITER_API_KEY` if you have one, or
   leave blank to keep testing without it.

6. **Then run the real test** — `trading-terminal-bot/README.md`'s Setup
   step 3: deploy the server publicly, open a real `/buy` Blink in
   Phantom or Backpack with a small amount, sign it, and check Solscan to
   confirm it actually lands. This is also the step that resolves the
   separate open question flagged in `server/jupiter.mjs` (whether a
   Blink client can land an `/order`-built transaction without calling
   Jupiter's `/execute`) — so it's doing double duty, not an extra step.

## If step 2 turns out to require a second wallet
That's a small extra bit of bookkeeping, not a problem: keep a short note
of which wallet is "Idea 1's fee wallet" vs. "Idea 3's fee wallet" so fee
revenue doesn't get confusing later, and route both to wherever you
actually want the money to end up (they can both forward to the same
place manually, or just stay separate — your call, not a technical
requirement either way).
