# Wallet Sourcing Plan — +$4k/30d Solana wallets → FlowRadar watchlist

**Status:** PLAN ONLY. No code, no import, no API calls yet. Companion to [WALLET_SOURCING_RESEARCH.md](WALLET_SOURCING_RESEARCH.md) and [REAL_7_DAY_WALLET_SHADOW_RUN_PLAN.md](REAL_7_DAY_WALLET_SHADOW_RUN_PLAN.md).

**Goal:** Source Solana wallets with **realized PnL ≥ $4,000 over a trailing 30 days**, verify a sample on-chain, import them as watched wallets, then (separately, on approval) run a 7-day forward shadow observation. Query-only. **No trading, no private keys, no threshold/FlowScore/promotion-logic changes.**

**Grounding (verified against the current code, `main` @ `be20dd5`):**
- Primary source = **Solana Tracker** `GET /v2/pnl/leaderboard/top`; free discovery cross-check = **Birdeye** `/trader/gainers-losers`; on-chain verifier = **Helius** (already wired). See research doc.
- Real importer = `packages/db/src/csv/importWalletsCsv.ts` (via `POST /api/import`). **Exact headers:** `wallet_address, chain, pnl_30d, realized_pnl_30d, unrealized_pnl_30d, win_rate, trade_count_30d, avg_trade_size_usd, tags, source`.
- Existing promotion gate (`packages/core/src/settings.ts` → `profitableWallet`, **do not change**): `pnl30d≥4000, minTrades≥8, minWinRate≥0.35, minRealized≥1000, minAvgTradeSizeUsd≥50`. Our sourcing filter is deliberately **stricter**, so it aligns without touching the gate.
- `CandidateWallet.source` vocab already includes `solana_tracker_pnl`, `birdeye_wallet_pnl`, `birdeye_top_traders`, `gmgn_smart_money`, `cielo`, `dune_token_overlap`, `csv_import`.

---

## Phase 2 — Wallet-quality filter

Applied **client-side** to raw leaderboard rows (no provider exposes a native min-PnL param). All inputs are **provider-claimed** until Phase 3. Defaults below are operator-tunable; they are a *sourcing pre-filter*, **not** a change to the promotion gate.

### Required (reject if any fails)
| Criterion | Rule | Rationale / vs gate |
|---|---|---|
| Realized PnL 30d | `realizedPnl30dUsd ≥ 4000` | The core ask; stricter than the gate's `minRealized≥1000`. |
| Trade count 30d | `tradeCount30d ≥ 20` | Excludes one-trade wonders; stricter than gate's `minTrades≥8`. |
| Active days 30d | `activeDays30d ≥ 5` *(if provided)* | Sustained activity, not a single lucky day. Solana Tracker `period.tradingDays`. |
| Volume 30d | `volume30dUsd ≥ 10000` | "Reasonable minimum" — real size behind the PnL. Tunable. |
| Win rate 30d | `0.35 ≤ winRate30d ≤ 0.95` | Sane band. Lower bound = gate's `minWinRate`. Upper bound rejects implausibly-perfect (wash/insider) wallets. |
| Avg trade size | `avgTradeSizeUsd ≥ 50` | Matches gate's `minAvgTradeSizeUsd`; excludes dust-spam. Derive = `volume30dUsd / tradeCount30d` if not given. |

### Exclusions (reject / flag)
- **Bot/spam signature:** extreme trade frequency (e.g. `tradeCount30d / activeDays30d > 200`/day) or sub-second median hold time → flag `possible_bot`. (Matches `candidateValidation`'s auto-reject of `possible_bot`/`mev`/`sniper` labels.)
- **Single-token concentration:** if a per-token breakdown is available and **> 90% of realized PnL comes from one token**, flag `concentration_extreme` (one lucky/insider trade, not repeatable skill). Requires per-wallet detail (Solana Tracker `/v2/pnl/wallets/{wallet}`, Nansen `top5_tokens`).
- **Impossible / dirty data:** `roi > 100000%`, `realizedPnl > volume`, negative volume/trades, `lastActive` in the future, or missing address → reject `dirty_data`.
- **Invalid address:** not a valid Solana pubkey (see Phase 4 validation) → reject.

### Nice-to-have (record if the source provides it; never required)
median trade size · avg hold time (`avgHoldTimeSecs`) · PnL distribution by token · last-active time (`timing.lastTrade`) · max drawdown *(rarely available)* · top-token concentration · a simple **copy-trade viability score** (e.g. `winRate × log10(tradeCount) × min(1, activeDays/15)`, display-only, **not** FlowScore).

> Source coverage: Solana Tracker gives realized/roi/volume/tradingDays/winRate/counts/lastTrade/avgHoldTime directly. Birdeye gainers-losers gives realized_pnl + basic counts (confirm schema). Volume/avg-size may need derivation. **Label every metric `provider_claimed`.**

---

## Phase 3 — Local verification (before trusting "smart")

Do **not** mark a wallet as verified-good on provider numbers alone. For **every high-stakes wallet and a random sample (≥ 20%) of the rest**:

1. **On-chain recompute (Helius, already wired):** pull recent swap history via `getWalletTransactions` (`packages/providers/src/solana/helius.ts`), normalize to `WalletTokenTrade` BUY/SELL rows, and run the existing **`computeFifoPnl`** (`packages/core/src/pnl/fifo.ts`) to get an independent realized-PnL/30d figure.
2. **Compare** provider-claimed vs Helius-derived realized PnL. Agreement within a tolerance (e.g. ±25% and same sign) → verified; wild disagreement or opposite sign → data-quality reject.
3. *(Optional, paid)* second-provider confirm (Birdeye `/wallet/v2/pnl/summary` `30d`, or Vybe `/v4/wallets/{address}/pnl`).

### Status labels (map to the existing pipeline)
| Label | Meaning | Where it lives |
|---|---|---|
| `provider_claimed` | Imported on provider numbers; not yet on-chain-verified. | default on import |
| `locally_verified` | Helius/FIFO recompute agrees with provider within tolerance. | recorded in wallet `tags`/`notes` (watched path) or `CandidateWallet.validationStatus=promoted` |
| `insufficient_history` | Too few on-chain trades in window to verify (do **not** promote as smart). | `CandidateWallet` "insufficient" verdict / note |
| `rejected_dirty` | Impossible data, provider-vs-onchain contradiction, or bot signature. | excluded / `CandidateWallet.validationStatus=rejected` |

**Do not falsely mark as smart if only provider-claimed.** The 7-day shadow run observes *forward* behavior regardless of label — the label just tells you how much to trust the *entry* metric.

> **Codebase interaction (important):** the CSV importer writes `WalletStats(source='csv')`, which `walletStatsRefresh` and `candidateValidation` **treat as authoritative and never overwrite**. So on the watched-CSV path, the Helius/FIFO recompute in Phase 3 is a **read-only cross-check** whose result you store in `tags`/`notes` (it will not, and should not, overwrite the imported provider stats). The `CandidateWallet` path (below) does this verification natively before promotion.

---

## Phase 4 — Import path

Two options. **The existing `importWalletsCsv` path goes straight to a watched `Wallet` (provider-claimed stats).** A locally-verified-before-promotion path exists via `CandidateWallet` but needs a feeder.

### Path A — Watched CSV import *(recommended for the 7-day forward shadow run)*
`POST /api/import` → `importWalletsCsv` → upserts `Wallet(isWatched=true)` + inserts `WalletStats(source='csv')`. The wallet is immediately watched, so `walletActivity` ingests its **forward** Helius activity — exactly what a forward shadow run needs. PnL stays provider-claimed (Phase 3 cross-check recorded in `tags`).

**Column mapping — collection template → importer's 10 columns** (this is the transform that matters):

| Collection column (template) | → Importer column | Transform |
|---|---|---|
| `wallet_address` | `wallet_address` | as-is (validate, below) |
| `chain` | `chain` | `SOLANA` |
| `pnl_30d_usd` | `pnl_30d` | as-is (total PnL) |
| `pnl_30d_usd` (realized) | `realized_pnl_30d` | realized portion; if only realized known, set `= pnl_30d_usd` |
| — | `unrealized_pnl_30d` | `0` if unknown (or provider's unrealized) |
| `win_rate_30d` **(percent 0–100)** | `win_rate` **(fraction 0–1)** | **÷ 100** — importer rejects values > 1 |
| `trade_count_30d` | `trade_count_30d` | integer ≥ 0 |
| `volume_30d_usd` | `avg_trade_size_usd` | `volume_30d_usd / trade_count_30d` (importer has **no volume column**; must be ≥ 0) |
| `source`, `source_url_or_query`, `confidence`, `roi_30d`, `notes` | `tags` | join as `|`-delimited, e.g. `solana_tracker|roi:1240|conf:provider_claimed|verified:pending` |
| `source` | `source` | the provider tag, e.g. `solana_tracker_pnl` |

**Validation & hygiene (do in the collection step, before import):**
- **Solana pubkey:** base58 charset **and** length 32–44. *(The importer only shape-checks; for higher assurance, base58-decode to exactly 32 bytes during collection and drop anything that fails.)* Never import an invalid address — the importer skips bad rows but collect clean.
- **De-duplicate** across sources by `wallet_address` **before** import; keep the **best** row per wallet. (The importer upserts `Wallet` on `[address,chain]` and inserts a *fresh* `WalletStats` that "wins" by `computedAt` — so a weaker re-import could shadow a stronger prior one. Dedupe-to-best pre-import avoids that.)
- **Do not overwrite better existing stats:** before importing an address already watched with `source='csv'`, compare and keep the better realized-PnL row; don't downgrade.
- **Size/scale:** target **50–200** candidates; **start with 50** (well within Solana Tracker's free 2,500-req/mo tier). Batch is fine — the `/api/import` route caps file size at 2 MB.

### Path B — CandidateWallet + validation *(rigorous, local-verified promotion; needs a feeder)*
Land rows as `CandidateWallet(source='solana_tracker_pnl'|'birdeye_wallet_pnl', claimedPnlUsd/claimedWinRate/claimedTradeCount/claimedRoi, …)` → `runCandidateValidation` assembles **local FIFO evidence** and promotes to `Wallet(isWatched=true)` **only if it clears the existing gate** (no logic change). This is the cleanest realization of Phase 3's `provider_claimed → locally_verified → promoted/rejected`.
- **Feeder options:** (i) the live connector adapters (T36) if wired to Solana Tracker/Birdeye; **or** (ii) a small **new CSV→CandidateWallet importer** (the current CSV path goes to `Wallet`, not `CandidateWallet`) — **this is new code and requires your explicit approval.**
- **Caveat:** validation's local FIFO needs the candidate's trades ingested first; a brand-new address with no ingested history validates as `insufficient` until its Helius history is pulled.

**Recommendation:** use **Path A** for the imminent 7-day forward shadow run (fast, observes forward activity, no code change), with Phase-3 Helius cross-checks recorded in `tags`. Reserve **Path B** for when you want promotion gated on local verification (and are ready to approve the small feeder).

---

## Phase 6 — Safety checklist (run before any long job; not executed now)

- [ ] **Back up / export the DB** (dump the LITE Postgres on :5439) before importing or starting the worker.
- [ ] Confirm `DUNE_EXECUTE_FRESH=false` (default; `.env` / `packages/providers/src/candidates/dune/client.ts`).
- [ ] Confirm **no BSC**: only `SOLANA` wallets imported; BSC connectors stay off.
- [ ] Confirm **no execution/trading**: no private keys, no swap/order endpoints, GMGN stays disabled/status-only.
- [ ] Confirm worker at **normal speed** (not `WORKER_FAST`) for a realistic soak.
- [ ] Confirm **Helius RPS sane** (`HELIUS_RPS` default 9; keep within your plan's limit).
- [ ] Confirm **no `.env`/secrets** printed or committed; API keys live only in `.env` (gitignored). `apiKeyEnvName` stores names only.

---

## Deliverables & gate

Produced now (docs only): this plan, the research report, the shadow-run plan, `docs/dune/solana_wallet_pnl_30d.sql` (illustrative secondary), and the collection template (`scratchpad/wallet-sourcing-template.csv`; header + example also embedded below).

**Nothing runs until you approve.** No API keys are needed to read these docs. Sourcing/importing and the shadow run each require your go-ahead.

### Collection CSV — header + example (see `scratchpad/wallet-sourcing-template.csv`)
```
wallet_address,chain,pnl_30d_usd,roi_30d,win_rate_30d,trade_count_30d,volume_30d_usd,source,source_url_or_query,confidence,notes
So1anaTrackERexampLEwaLLetAddressBase58Xyz1234,SOLANA,8250.50,142.0,58.0,64,145000,solana_tracker_pnl,https://docs.solanatracker.io/data-api/pnl-v2/leaderboard,provider_claimed,days=30 sort=realized
BirdEyeGainersExampLEwaLLetAddrBase58Abc9876,SOLANA,5100.00,71.5,46.0,38,220000,birdeye_top_traders,https://docs.birdeye.so/reference/get-trader-gainers-losers,provider_claimed,type=30d sort_by=realized_pnl
```
*(Addresses above are illustrative placeholders — not real wallets.)*
