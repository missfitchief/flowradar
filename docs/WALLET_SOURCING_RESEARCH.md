# Wallet Sourcing Research — Solana wallets with realized PnL ≥ $4,000 / 30d

**Research date:** 2026-07-09. **Method:** official-docs-first web research across 5 source families, adversarially cross-checked. **Not verified with any live authenticated API call** — every capability, field, price, and rate limit below is **provider-claimed** from vendor docs and held at **medium confidence** until confirmed with a real key. Prices/limits change; each carries its source URL. Re-verify §7 before spending money.

Full raw findings archived at the analyst's consolidated notes (scratchpad `wallet-sourcing-findings.md`).

---

## 1. Executive answer

**Primary source: Solana Tracker.** It is the only provider whose single documented endpoint natively does the job — `GET /v2/pnl/leaderboard/top` ranks wallets by **realized PnL over a native 30-day window** (`days=30&sort=realized&direction=desc`) with real pre-filters (`minTrades`, `minInvested`, `minWinRate`, `minRoi`). Pricing is transparent and cheap: **Free = 2,500 req/mo (3 rps)**, then EUR 50 / 200k. Effort to first candidates: **one endpoint + one client-side post-filter** for `period.realized ≥ 4000`.

**Free/cheap fallback + cross-check: Birdeye `GET /trader/gainers-losers`** (`type=30d&sort_by=realized_pnl`, Solana) — a real cross-wallet leaderboard available on **all tiers including free Standard ($0)**. Its exact response JSON schema is not in the docs and must be confirmed with one test call.

**Ground truth: Helius** (already wired in FlowRadar) — no PnL of its own, but the on-chain verifier: pull raw swap history, recompute realized PnL, and flag providers that disagree.

**Net cost to start: $0** (Solana Tracker free tier or Birdeye Standard). First paid step is only if you exceed free quotas or want Birdeye's per-wallet confirmation ($199/mo Premium).

**⚠ Universal caveat:** *no vendor exposes a native "minimum realized-PnL amount" parameter.* The `≥ $4,000` cut is a **client-side post-filter everywhere**. And every provider's PnL is **provider-calculated** with its own wash-trade/fee methodology — none was cross-checked against on-chain data. Spot-check a sample via Helius before trusting any number.

---

## 2. Comparison table (all provider-claimed)

| Source | Public API? | Wallet PnL? | Discovery / leaderboard? | 30d realized filter | Cost (provider-claimed) | Conf. |
|---|---|---|---|---|---|---|
| **Solana Tracker** | Yes | Yes | **Native** `/v2/pnl/leaderboard/top` | native 30d + sort=realized; **≥$4k = post-filter** | Free 2,500/mo (3 rps); EUR50/200k; EUR200/1M | Med+ |
| **Birdeye** | Yes | Yes | **Yes** `/trader/gainers-losers` (all tiers) | `type=30d`+`sort_by=realized_pnl` (Solana); **post-filter** | Discovery **free**; per-wallet PnL = **$199/mo** | Med |
| **Nansen** | Yes | Yes | **Per-token** `tgm/pnl-leaderboard` | **native** `pnl_usd_realised.min≥4000` (per token, aggregate) | Pro **$49–69/mo**, 2,000 credits, 5/call | Med |
| **Cielo** | Yes | Known wallets only | **No API discovery** (UI-only) | per-wallet `timeframe=30d` | Builder **$89/mo** min | Med |
| **Dune** | Yes | Custom SQL only | Community dashboards only | compute in SQL, then filter/post-filter | Free 2,500 credits/mo; ~$65–75/mo (unverified) | Med |
| **GMGN** | Official but thin | Yes (7d/30d) | Pre-tagged pools only | `period=30d`; post-filter | No price found; **1 req/s** | Low–Med |
| **Vybe** | Yes | Yes (`30d`) | Leaderboard exists, schema unconfirmed | per-wallet 30d confirmed | Pricing 404'd (**unverified**) | Low–Med |
| **Helius** | Yes | **No** (raw txs) | No | — | **verification layer** | Med (verifier) |
| Moralis / Solscan / SolanaFM / Step / Flipside | Yes | Mostly no Solana PnL | No | No | — | Low (excluded) |

---

## 3. Per-source detail

### Solana Tracker — recommended primary
- **Endpoints:** leaderboard `GET /v2/pnl/leaderboard/top` (`days=1|7|30|90`, `sort=realized`, `direction=desc`, pre-filters `minTrades`/`minInvested`/`minWinRate`/`minRoi`); per-wallet `GET /v2/pnl/wallets/{wallet}` (`pnlMode=strict|adjusted|raw`).
- **Fields (leaderboard):** `wallet`, `period.realized`, `period.volume`, `period.roi`, `period.tradingDays`, `period.days.winRate`, `counts.trades/buys/sells`, `winRate`, `timing.lastTrade`, `identity.name/twitter`. **(per-wallet):** `summary.pnl.realized/unrealized/total`, `summary.roi`, `summary.timing.lastTrade/firstTrade/avgHoldTimeSecs`, `analysis.winRate`, `stats.profitable/losing`.
- **Auth:** `x-api-key`. **Cost (from live pricing page):** Free EUR0 / 2,500 req-mo (3 rps); Advanced EUR50/200k; Pro EUR200/1M; Premium EUR397/10M. No PnL/leaderboard tier-gating found.
- **Docs:** `docs.solanatracker.io/data-api/pnl-v2/leaderboard/solana-traders-leaderboard`, `.../pnl-v2/wallet/get-wallet-summary`, `www.solanatracker.io/data-api`.
- **Caveats:** no native min-PnL param → post-filter `period.realized`. Human docs UI 404s on plain fetch (JS-gated); findings came from same-domain `.md`/`llms.txt` mirrors — **re-verify in a browser with a real key.** PnL is provider-calculated.

### Birdeye — free discovery fallback (+ optional paid per-wallet confirm)
- **Endpoints:** discovery `GET /trader/gainers-losers` (`type=today|1W|30d|90d`, `sort_by=PnL|realized_pnl|unrealized_pnl`; 30d/90d Solana-only) — **all tiers incl. free**. Per-token `GET /defi/v2/tokens/top_traders`. Per-wallet `GET/POST /wallet/v2/pnl/{summary,details,multiple}` (`duration=30d`) — **Premium $199/mo+, Solana-only, "beta."**
- **Fields (per-wallet):** `realized_profit_usd`, `realized_profit_percent`, `unrealized_usd`, `total_usd`, `total_buy/sell/trade`, `total_win/loss`, `win_rate`, `total_invested/sold/current_value`, `avg_profit_per_trade_usd`. **Leaderboard JSON keys NOT recoverable from docs — biggest gap.**
- **Auth:** `X-API-KEY`. **Cost:** Standard **free** (30k CU, 1 rps); Lite $39; Starter $99; Premium $199; Business $499+. Discovery endpoints = all tiers; per-wallet PnL = Premium+.
- **Docs:** `docs.birdeye.so/reference/get-trader-gainers-losers`, `.../get-wallet-v2-pnl-summary`, `.../docs/pricing`.
- **Caveats:** no min-PnL param; free-leaderboard schema unverified; a rate-limit conflict (100 rps documented for gainers-losers vs a 5 rps/75 rpm "beta" note for v2 wallet PnL) is **unresolved**.

### Nansen — strongest native filter, but per-token
- `tgm/pnl-leaderboard` takes `chain=solana`, free-form `date.from/to` (30d = compute client-side), and **`filters.pnl_usd_realised.min ≥ 4000` natively** — but **`token_address` is required** (per-token, not a global scan). Discovery = iterate a seed list of Solana tokens and aggregate/dedupe traders (5 credits/token; 2,000-credit Pro ≈ ~400 token queries). Fields: `trader_address`, `pnl_usd_realised/unrealised/total`, `roi_percent_*`, `nof_trades`, `holding_*`, `still_holding_balance_ratio`, `netflow_*`. Auth `apiKey`. Pro **$49/yr-mo, $69/mo**.
- **Docs:** `docs.nansen.ai/api/token-god-mode/pnl-leaderboard`.

### Cielo — per-wallet only; **not a discovery fit**
- `pnl/tokens` (5 cr) + `pnl/total-stats` (20 cr) for a **known** wallet (`timeframe=1d|7d|30d|max`). The app's "Wallet Discovery" is **UI-only, not an API endpoint** → cannot discover new wallets via API. Response schema + auth-header name unconfirmed. Builder **$89/mo** min. Docs: `developer.cielo.finance/reference/gettokenspnl`.

### Dune — build-your-own; cached reads work (see §4)
- Generic SQL-results API, no native PnL product. Base table `dex_solana.trades` (`trader_id`, token amounts, `amount_usd`, `block_time`) — realized PnL must be computed in SQL (FIFO). Community dashboards do this but are **unverified**. Auth `X-DUNE-API-KEY`. Free 2,500 credits/mo; rate limits officially confirmed (Free ~55 rpm). Docs: `docs.dune.com/api-reference/executions/endpoint/get-query-result`.

### GMGN — official but thin → **stub/status-only** (see §5)
- Official key-auth API (GitHub `GMGNAI`, `docs.gmgn.ai`) exposes per-wallet `portfolio stats` (`period=7d|30d`: `realized_profit`, `unrealized_profit`, `winrate`, `total_cost`, buy/sell counts) + `track smartmoney`/`track kol` seed feeds. **No formal OpenAPI/field reference**, throttled to **1 req/s**, discovery limited to GMGN's **pre-tagged** pools. Trading/swap needs a private key — **hard out of scope, never use.**

### Others
- **Vybe:** per-wallet `GET /v4/wallets/{address}/pnl` (`resolution=30d`: `realizedPnlUsd`, `winRate`, `tradesVolumeUsd`, per-token) is solid; leaderboard `/wallets/top-traders` exists but schema/pricing **unverified** (page 404'd; "$2,000/mo" figure is a **rumor**).
- **Moralis:** EVM profitability clear; **Solana PnL unconfirmed** in the Solana ref.
- **Solscan Pro / SolanaFM / Step:** no documented wallet-PnL/top-trader endpoint. **Flipside:** SQL-only (like Dune). **Helius:** no PnL — verification layer only (`helius.dev/docs/wallet-api/balances`).

---

## 4. Dune specifics (cached-only feasibility)

- **Cached-only reads work.** `GET /api/v1/query/{query_id}/results` (Dune docs: *"only retrieves cached results — it does not trigger a new query execution"*). This is the `DUNE_EXECUTE_FRESH=false` path FlowRadar already uses (`packages/providers/src/candidates/dune/client.ts` → `fetchLatestCachedResult` → `GET /v1/query/{id}/results`). **No `POST /execute` needed.**
- **But cached reads still consume credits** (size-metered); Dune publishes **no per-request credit formula**.
- **Public Solana top-trader/PnL dashboards found** (all community-authored, unverified — page titles only): `dune.com/couldbebasic/top-traders`, `dune.com/queries/3514694` ("Top PnL Solana Wallets Overview"), `dune.com/webtester5/solana-wallet-pnl`, `dune.com/ves/solana-wallet-pnl`, plus `dune.com/data/dex_solana.trades` (official raw table).
- **Verdict:** build-your-own only; **not turnkey**. Keep Dune as a **secondary cross-check**, read cached, after verifying a forked query's SQL. A starter template ships at `docs/dune/solana_wallet_pnl_30d.sql` (illustrative).

## 5. GMGN verdict

An **official** GMGN key-auth API exists (supersedes the stale "no API" claim) but is thin: "AI-agent skills"/CLI packaging, no OpenAPI, 1 req/s, discovery only over pre-tagged pools. **Recommendation: wire as a disabled-by-default, status-only stub** (matches FlowRadar's existing `createGmgnProvider` stub). Do **not** build sourcing on it; do **not** use any third-party scraper (Parse.bot, Apify, etc.); the private-key Trading API is **hard out of scope**.

## 6. UNCERTAIN — operator must confirm before spending

1. **Solana Tracker** docs via `.md`/`llms.txt` mirror — re-verify leaderboard params + pricing in a browser with a real key; and whether per-wallet summary supports a native 30d window.
2. **Birdeye** free-leaderboard response schema (unverified) + the 100 rps vs 5 rps/75 rpm conflict + per-endpoint CU cost + whether $199 Premium is truly needed.
3. **Dune** pricing (~$65–75/mo secondhand; page rendered nav-only) + actual per-cached-read credit cost (undisclosed).
4. **GMGN** pricing/rate-limit scope; **Nansen** flexi-credit top-up price; **Cielo** auth header + schema; **Vybe** pricing + leaderboard schema; **Moralis** Solana PnL support.
5. **All PnL is provider-calculated** — methodology differs; none cross-checked on-chain.

## 7. Recommended sourcing order

1. **Discover (primary):** Solana Tracker `GET /v2/pnl/leaderboard/top` (`days=30&sort=realized&direction=desc`, `minTrades`/`minInvested` to trim), paginate desc, **post-filter `period.realized ≥ 4000`**. Free tier.
2. **Discover (free cross-check + dedup):** Birdeye `GET /trader/gainers-losers` (`type=30d&sort_by=realized_pnl`, Solana), free Standard; merge/dedupe addresses. *(Optional native-filter third seed: Nansen `tgm/pnl-leaderboard` over a token seed list, if you hold Pro.)*
3. **Confirm per-wallet (optional, paid):** Birdeye `/wallet/v2/pnl/summary` (`30d`, Premium) or Vybe `/v4/wallets/{address}/pnl` (`30d`) for the ones that matter — two independent agreements ≈ higher confidence.
4. **Ground-truth verify (Helius, already in FlowRadar):** for a **sample** + high-stakes wallets, pull raw swap history and recompute realized PnL via the existing FIFO engine; flag provider-vs-onchain disagreement as a data-quality reject.
5. **Dune secondary cross-check only:** fork a community realized-PnL query on `dex_solana.trades`, read **cached** (`DUNE_EXECUTE_FRESH=false`) — credit-metered; verify the SQL first.

---

*Bottom line: source with **Solana Tracker** (free, native 30d realized-PnL leaderboard), corroborate with **Birdeye's free `/trader/gainers-losers`**, validate a sample on-chain via **Helius**. GMGN stays a disabled status-only stub; Dune/Nansen/Cielo/Vybe are optional paid cross-checks. Everything provider-claimed until locally verified.*
