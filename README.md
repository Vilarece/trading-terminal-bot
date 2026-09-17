# Clearlane Terminal (Idea 3): non-custodial trading bot

A Telegram trading bot that never holds a user's wallet. People trade **any
Solana token** from chat and sign every trade in their own wallet
(Phantom, Solflare, Backpack). Live at
[@ClearlaneTerminalBot](https://t.me/ClearlaneTerminalBot).

## v0.2 (Sept 17, 2026): any token, referrals, always-on bot

- **Trade any token.** `/buy`, `/sell` and `/price` accept a symbol or a
  mint address, and pasting a bare token address into the chat shows a
  token card with buy buttons. Lookups use Jupiter's Tokens API v2.
  *Why this now works without per-token setup:* Jupiter Ultra collects the
  referral fee in **SOL** whenever SOL is one side of the trade. This was
  confirmed live for SOL->WIF and WIF->SOL, a mint with no referral token
  account (`feeMint` = SOL, `feeBps` = 50). Our referral account already
  has a wSOL token account, so every SOL-paired trade pays the fee.
- **Safety flags before any buy:** unverified token, low liquidity, mint or
  freeze authority still enabled, concentrated holders, low organic activity.
- **Referral program.** `/ref` gives each user a personal invite link
  (`t.me/ClearlaneTerminalBot?start=ref_<id>`). Referrers earn 30% of our
  net fee, which is 0.12% of their referrals' trade volume. `/wallet`
  sets the payout address. Payouts are sent **manually** by the admin
  (`/payouts` lists what's owed, `/paid ID USD` records a payment).
  Attribution is first-touch, and users can't refer themselves.
- **Trade tracking.** The trade page now gets quotes through `/api/order`
  and submits through `/api/execute`. Both simply relay to Jupiter and add
  our referral fee server-side, which lets the server credit each
  completed trade to the right user and referrer and notify the admin.
  Users still sign in their own wallet, and the server never sees a key.
- **Mobile wallets.** Buttons open the trade page inside the Phantom or
  Solflare apps, where the wallet is built in. This removes the "no wallet
  found" dead end in Telegram's in-app browser. The trade page also has a
  Max button (balances come from Jupiter's holdings API), a buy/sell flip
  button and SOL amount presets.
- **Always-on on Render's free plan.** The bot now uses a Telegram
  **webhook** and runs in the same process as the trade page (`app.mjs`).
  Previously it long-polled from a separate free service, and Render sleeps
  free services after about 15 minutes without *incoming* requests, so the
  bot went silent. Each Telegram message now wakes the service, and a
  10-minute self-ping keeps it warm. One always-on free service uses about
  720 of Render's 750 free hours a month, so don't keep a second free
  service awake as well.
- **Durable ledger without a database.** Referral and trade data is kept
  in memory and backed up as a JSON file pinned in the admin's private
  chat with the bot (`ADMIN_CHAT_ID`), then reloaded on startup.

### Environment (v0.2)

| Var | Needed? | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes, for the bot | Without it, only the web and API run. |
| `ADMIN_CHAT_ID` | recommended | Your own chat id with the bot (send it `/whoami`). Enables trade alerts, `/stats`, `/payouts` and the durable ledger. |
| `REFERRAL_ACCOUNT` | optional | Defaults to Idea 3's Ultra referral account `9nv5…FhY3`. |
| `PLATFORM_FEE_BPS` | optional | Default 50 (Jupiter's minimum). |
| `REF_SHARE_PCT` | optional | Default 30 (% of our net fee paid to referrers). |
| `JUPITER_API_KEY` | optional | Higher rate limits. |
| `PUBLIC_BASE_URL` | local only | On Render, `RENDER_EXTERNAL_URL` is used automatically. |

`SUPPORTED_TOKENS_JSON` is no longer used.

---

## History: original notes (Sept 11–15, 2026)

## Migration status (Sept 11, 2026)

`server/jupiter.mjs` and `server/public/trade.html` were migrated off the
dead `quote-api.jup.ag/v6` API to `api.jup.ag/swap/v2` — the same fix Idea
1's widget got Sept 9. `PLATFORM_FEE_BPS` default bumped 20 → 50 (Jupiter's
new referral-fee floor) and `.env.example`/this README corrected: Idea 3
needs its **own** referral account, it cannot reuse Idea 1's.

**Not yet resolved — test before calling this launch-ready:** the trade
page (`trade.html`, opened in a real browser tab) mirrors Idea 1's proven
sign-then-execute flow and should work the same way. The Solana Actions
("Blinks") route in `server/index.mjs`, though, hands an unsigned
transaction to a *third-party* Blink client (Phantom, Backpack, dial.to)
that signs it and submits it itself — almost certainly via a plain RPC
call, not Jupiter's own `/execute`. Whether a `/order`-built transaction
reliably lands on-chain that way (skipping `/execute` entirely) isn't
clearly documented either way. See the long comment at the top of
`server/jupiter.mjs` for the full explanation and the fallback plan
(Jupiter's `/build` endpoint) if it doesn't. **Do not skip step 3 below** —
it's the only way to actually know.

## Read this first: the architectural trade-off

Custodial bots like Trojan let you tap a button in Telegram and trade
instantly, because the bot generated a wallet and is holding it *for* you.
That's exactly the design this project won't copy — it's also exactly why
Photon's Trustpilot reviews describe funds disappearing and Trojan's real
cost runs above its advertised fee (see the main plan's competitive
research).

The honest catch: Telegram's in-chat interface (its "Mini App" webview) is a
sandboxed browser context that wallet extensions like Phantom **cannot**
inject into. There is no way to get an instant, fully in-Telegram,
non-custodial "tap to trade" button — that combination doesn't exist yet.
So this build uses the two mechanisms that *do* achieve real non-custodial
trading from a chat surface:

1. **Solana Actions ("Blinks")** — an open Solana standard specifically
   built for this: a link that a Blinks-aware wallet (Phantom, Backpack) or
   client (X/Twitter) can open directly and render as a "Buy" button,
   fetching an unsigned transaction from our server and handing it to the
   wallet to sign. Our server never sees a private key at any point.
2. **A plain trade page** (reusing Idea 1's widget) as the fallback for any
   wallet without Blink support yet — opened in a real browser tab, not
   Telegram's webview, where a wallet extension works normally.

Both routes cost the user one extra tap compared to a custodial bot. That
tap is the whole value proposition — see the messaging lines in the main
plan's Section 7. Don't try to engineer that tap away by adding custody
later without treating it as the deliberate, separate decision the plan's
Section 2 says it should be.

## What's here

```
server/
  index.mjs      Express server: Solana Actions API (GET/POST /api/actions/buy),
                 actions.json discovery file, /api/price, and the static trade page.
  jupiter.mjs    Quote + unsigned-swap-transaction builder. Migrated Sept 11,
                 2026 to Jupiter's current api.jup.ag/swap/v2 API (see
                 Migration status above and the file's own header comment).
  public/
    trade.html   Fallback swap widget (adapted from Idea 1), pre-filled from
                 the URL the bot sends. Same Sept 11 migration as jupiter.mjs.
bot/
  index.mjs      Telegram long-polling bot: /buy, /price, /tokens, /help.
                 Sends links; never builds or signs anything itself.
```

## (Superseded in v0.2) Why "supported tokens" was a curated list

Jupiter's referral-fee mechanism (the same one Idea 1 uses) pays fees into a
**Referral Token Account you create for each specific output mint** —
there's no way to collect a fee on an arbitrary, never-before-seen token
without first creating that account. Real "snipe any brand-new token" bots
solve this by appending a separate flat SOL fee-transfer instruction into
the transaction rather than using Jupiter's referral system at all — a
valid but meaningfully more complex approach (it means decompiling and
re-signing the transaction message Jupiter returns) that this MVP
deliberately doesn't attempt without being able to test it live first. Ship
this as-is for a curated, growable token list; treat "arbitrary new token
support" as a real fast-follow, not a missing feature of this version.

To add a token: create a Referral Token Account for its mint at
referral.jup.ag (Idea 3's own account — see Migration status above), then
add it to `SUPPORTED_TOKENS_JSON` in both `.env` (server) and the `TOKENS`
array in `server/public/trade.html`.

## Setup

1. **Deploy the server somewhere with a real public HTTPS URL.** This is the
   one hard requirement Ideas 1–2 didn't have — Blinks and wallet redirects
   both need a stable, secure domain, not localhost. A free tier on
   Render/Fly.io/Railway is enough to start.
   ```bash
   npm install
   ```
   Copy `.env.example` to `.env`, fill in `PUBLIC_BASE_URL` (once you know
   your deployed URL) and `REFERRAL_ACCOUNT`. **Create Idea 3's own
   referral account at referral.jup.ag first — do not reuse Idea 1's** (see
   Migration status above for why), plus a Referral Token Account there for
   every mint in `SUPPORTED_TOKENS_JSON`. Then:
   ```bash
   npm run server
   ```

2. **Test the Actions API directly, before involving Telegram at all:**
   ```bash
   curl "https://<your-deployed-url>/api/actions/buy?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
   ```
   Should return the Blink metadata JSON. If it does, the core of this
   product works independent of any Telegram or wallet-app nuance.

3. **The real test — confirm a Blink actually lands on-chain.** This is the
   step that resolves the open question in Migration status above. Message
   your bot `/buy BONK 0.1` (after step 4 below sets up the bot) or build
   the Blink URL by hand, open it in Phantom or Backpack with a **small**
   real amount, sign, and then check the transaction signature on Solscan
   to confirm it actually landed — not just that the wallet accepted it for
   signing. If it doesn't land within a normal confirmation window, the fix
   is switching `server/jupiter.mjs` from `/order` to Jupiter's `/build`
   endpoint (self-broadcast by design; see the file's header comment for
   the tradeoff — it requires assembling raw instructions yourself instead
   of getting a ready-made transaction back).

4. **Create the Telegram bot** the same way as Idea 2 (message @BotFather),
   put the token in `.env`, then:
   ```bash
   npm run bot
   ```
   Message your bot `/help`, then try `/buy BONK 0.1` per step 3 above.

## Note on this environment

Like Ideas 1 and 2, this was originally written and syntax-checked in a
network-restricted sandbox that couldn't reach Solana's RPC, Jupiter's API,
or Telegram's API to run it live — and the Sept 11, 2026 API migration was
done the same way, informed by Jupiter's public developer docs rather than
a live test run. The Solana Actions spec fields used here
(`ActionGetResponse`'s `icon`/`title`/`label`/`links.actions`,
`ActionPostResponse`'s `transaction`/`message`, the `actions.json` rules
format) were confirmed against current documentation, not guessed — but
step 3 above, run yourself, is the real proof this works end-to-end.

## Fast follows (not needed to launch)

- ~~Arbitrary token support~~ **Done in v0.2** (fee is collected in SOL; see top).
- ~~Sell flow~~ **Done in v0.2.**
- **New-pair alerts**, reusing Idea 2's polling pattern, to give the bot
  something to post proactively instead of only responding to commands.
- **More Blink-aware surfaces** — the same `/buy` link that works in
  Telegram also works pasted into X/Twitter or Discord once those
  communities exist, at zero extra engineering cost.
