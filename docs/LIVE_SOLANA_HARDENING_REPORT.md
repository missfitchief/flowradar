# FlowRadar — Live Solana Post-MVP Hardening Report

**Date:** 2026-07-07
**Scope:** Local checkpoint of the post-MVP hardening pass that made the **Solana** live worker path stable and safe for extended local operation. This documents live **ingestion + stability**, not signal profitability. BSC was intentionally not touched.

All work below was done as isolated, scoped fixes using a focused implementer → focused reviewer (subagent) → fix → `npm run verify` → live-soak loop. Each fix is its own commit; no source changes were bundled with this report.

---

## 1. Current commit chain (post-MVP hardening)

Branch `main`, four fixes stacked on top of `7741cb3` (the `POST_MVP_AUDIT.md` doc commit), in order:

| Commit | Type | Summary |
|--------|------|---------|
| `bcac906` | fix(worker) | Rate-limit Helius walletActivity polling — `HELIUS_RPS` env-configurable (default 9), 429 exponential backoff honoring a bounded `Retry-After`, typed `HeliusRateLimitError`. |
| `eaee421` | fix(worker) | Bounded walletActivity initial backfill — per-page ingest, page cap (`WALLET_ACTIVITY_MAX_PAGES`, default 5), early-stop on empty since-filtered page; memory bounded per page. |
| `0523167` | fix(db) | Bounded downstream market-snapshot loading — flowScoring/signalDetection now load only the 3 boundary snapshots `aggregateWindow` reads (earliest + latest ≤ to + latest ≤ from per window) instead of a token's ever-growing full history. Score-exact. |
| `113bb3c` | fix(providers) | USDT / mega-holder token risk "unavailable" handling — Helius `-32600 "too many accounts"` from `getTokenLargestAccounts` is classified as *holder-data-unavailable* and degraded gracefully instead of failing the token's score every cycle. |

Full hashes:
- `bcac906a8aa557eb7f830eec382a22dead43818f`
- `eaee421b54ab399f9b270bbb4e3bff91f6af9941`
- `052316716dbcbc18d815fb1ce75bdccc5e26df37`
- `113bb3cb59d2550b04e21a1e1cf49baeeb27972f`

Each fix shipped with new regression tests; the tree is clean and `npm run verify` is green (890 passed / 1 skipped) on a clean/rebuilt DB.

---

## 2. Release tag

`v0.1.0-mvp` **remains untouched at `4a49cfb`** (the MVP merge point). None of the hardening commits moved or re-pointed the tag.

---

## 3. Remote / push status

**No git remote is configured. Nothing has been pushed.** All four hardening commits exist only in the local `main` branch.

---

## 4. Solana live validation results

### Environment
- **Real 18-wallet DB.** The DB was rebuilt clean and seeded with **18 real Solana wallet addresses** (imported from a SolanaTracker-sourced CSV via the wallet-import path — operator-vouched Layer-1, not synthetic seed data). Confirmed state at soak start: `wallets=18, watched=18, tokens=0, trades=0`.
- **Real trades ingested.** Live Helius Enhanced-Transactions polling ingested real on-chain trade history for those wallets during each soak (bounded per the F7 page cap).
- Live mode: `MOCK_MODE=false`, normal worker speed (no `WORKER_FAST`), `HELIUS_RPS=5`, `DUNE_EXECUTE_FRESH=false`.

### F8 soak — 50 minutes (bounded market-snapshot load)
- Duration: 50 min (100 RSS samples). Worker reaped cleanly.
- **Memory: plateaus.** RSS ramped 134 → ~530 MB over the first ~24 min as the dataset filled, then held a flat sawtooth band **~520–558 MB (mean ~530)** for the final ~26 min — no upward slope (the last sample sat below several earlier peaks). The pre-F8 unbounded climb (previously observed 91 → 399 MB and still rising) is gone; steady-state memory is now bounded by dataset working-set size rather than growing every cycle.
- Ingestion: 18,491 txs ingested (cycle-sum); DB grew to **301 tokens / 17,731 trades** (+1,273 market snapshots, 124 flow snapshots, 0 signals — no rules fired, expected; thresholds untouched).
- Per-job cycles (healthy): walletActivity 39, marketDataHot 50, marketDataNormal 9, flowScoring 49, signalDetection 50, entityClustering 16, moneyFlow 50, bridgeFlow 25, profitRotation 25, alertDispatch 100, duneQuery 0.
- **Discovered issue → became F9:** the Solana USDT mint failed `getTokenLargestAccounts` with Helius `-32600` on every scoring cycle (60 "failed to score" errors), caught but noisy, and that token never scored.

### F9 soak — 20 minutes (mega-holder risk-unavailable handling)
- Duration: 20 min (40 RSS samples). Worker reaped cleanly.
- **Fix exercised and proven on live data:** USDT was ingested with **326 BUY/SELL trades**, so flowScoring called `getTokenRisk(USDT)` → hit the `-32600` path → and USDT **scored (17 flow snapshots) with 0 errors**. (USDC + wSOL were also ingested but transfer-only, so their risk path was not invoked.)
- **Log spam eliminated:** `0` occurrences of "too many accounts", `0` "failed to score", and the worker **stderr log was empty (0 lines)** — versus the F8 soak's 60 recurring error lines.
- flowScoring: 25 cycles, **all `errors:0`**.
- Memory: RSS 132 → 439 MB (max 458.6) — normal dataset-fill ramp (20 min is still inside the ramp phase; same shape as F8's first 20 min). DB reached 217 tokens / 15,623 trades.

### Cross-cutting results (both soaks)
- **Helius 400 = 0, Helius 429 = 0** (F6 rate-limiting holding under live load).
- **Dune execute = 0** (`duneQuery` never fired; `DUNE_EXECUTE_FRESH=false` respected — credit-safe).
- **No crashes / fatal / unhandled rejections = 0**, and **0** connection-pool timeouts (`P2024`) in the worker during either soak.

---

## 5. Known operational notes

- **`.env` is local and git-ignored** — never committed, and no key values are printed in logs or this report.
- **`DUNE_EXECUTE_FRESH=false`** — Dune fresh-query execution stays disabled; the connector uses the credit-safe latest-cached-result path only.
- **`HELIUS_RPS=5`** was used for the live soaks (below the free-tier limit; the default is 9).
- **`WORKER_FAST` must NOT be used for live providers.** It overrides every job interval to 3s, which floods Helius past the rate limit (it is a mock-mode verification tool only). Live runs use normal worker speed.
- **`npm run verify` should be run against a clean/rebuilt DB, not the post-soak DB.** The historical-replay test (`replayRunner`) can hit a Prisma connection-pool timeout (`P2024`, pool limit 13 / timeout 10s) when the ambient DB carries soak-scale residue (hundreds of tokens / tens of thousands of trades). Rebuild the clean 18-wallet DB first, then verify. (This is a test-harness/DB-size interaction, not a regression in the shipped code.)

---

## 6. Remaining non-blocking limitations

- **Steady-state RSS scales with the trade/token dataset size.** F8 removed the per-cycle unbounded growth, so memory now plateaus — but the plateau level rises with the size of the tracked universe. Full trade history is still loaded per token per cycle by design (`aggregateWindow` needs it for `newSmartBuyers` / trailing-window volume). For multi-day continuous operation, a trade-history window/prune would bound this further.
- **No signal edge proven yet.** These soaks validate live **ingestion and stability**, not profitability. No signal rules fired against the real 18-wallet set, and thresholds were deliberately not tuned. Signal quality can only be validated by historical replay + shadow mode against outcomes.
- **No BSC validation.** BSC was intentionally left untouched; only Solana was hardened and soaked.
- **No remote / no push.** All hardening lives in local `main` only.

Additional pre-existing note (out of the hardening scope): the live worker does not persist `Token.riskFlags` for live tokens (the seed path does). F9's `holder_data_unavailable` flag is therefore surfaced at the provider-contract level; persisting risk flags in the live scoring path would be a separate small follow-up and affects all risk flags, not just this one.

---

## 7. Recommended next steps

1. **Add a private remote and push** the local `main` (four hardening commits + this report) so the work is backed up off this machine.
2. **Optionally tag a new post-MVP local checkpoint** (e.g. `v0.1.1-hardening`) at `113bb3c` — leaving `v0.1.0-mvp` where it is.
3. **Run a longer 2–6 hour Solana-only soak** (normal speed, `HELIUS_RPS=5`) to confirm the memory plateau and stability hold over a sustained window before expanding scope.
4. **Only after Solana is confirmed stable, start BSC as a separate scoped track** (BscScan/GoPlus adapters already scaffolded) — validated the same way: scoped fix → reviewer → verify → live soak.

---

*This report is a local checkpoint. It documents the state of the four Solana hardening fixes and their live-soak evidence at the time of writing; it makes no code changes and does not alter the release tag or git remotes.*
