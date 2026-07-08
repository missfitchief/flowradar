# FlowRadar — Final Integration Checkpoint

**Checkpoint baseline:** `main` @ **`be20dd5`** — "Merge pull request #2 from missfitchief/feat/external-confluence" (= `origin/main`; this report is committed as the immediate next commit on top of it).
**Date:** 2026-07-08.
**Purpose:** Record the integrated state of `main` after MVP + Solana hardening + social intelligence + external confluence, and mark a deliberate stop pending real source/API access.

---

## 1. Current `main` HEAD

- `be20dd5` — merge commit for PR #2 (external confluence). Local `main` == `origin/main` == `be20dd5`.
- The merge introduced **no code delta**: `git diff ad35f3b be20dd5` is empty, so the pre-merge gate (verified on the reviewed branch tip `ad35f3b`) holds for `be20dd5` verbatim.

## 2. `v0.1.0-mvp` tag status

- **Unchanged: `4a49cfb`.** Not moved or retagged across any of the post-MVP tracks. It still marks the original MVP merge.

## 3. Merged feature tracks

Three merge commits sit above the MVP on `main`:

| Track | How it landed | Commit(s) |
|---|---|---|
| **FlowRadar MVP v0.1.0** | `Merge feat/mvp` | `49a079d` (tag `v0.1.0-mvp` @ `4a49cfb`) |
| **Solana live hardening (F6–F9)** | committed to `main` directly, live-validated | F8 bounded market-snapshot load + reviewer hardening; F9 Solana mega-holder `getTokenLargestAccounts -32600` → graceful `holder_data_unavailable` (`113bb3c`); report `docs/LIVE_SOLANA_HARDENING_REPORT.md` (`1ecbb4d`) |
| **Social intelligence (shadow-only, Tasks A–G)** | **PR #1** merged | `Merge pull request #1` (`08fc805`), incl. M1 velocity-cutoff fix `ab470c3` |
| **External confluence (shadow-only, Tasks A–F)** | **PR #2** merged | `Merge pull request #2` (`be20dd5`): `ee2d586` LiquidityRisk core · `ee7d79e` schema · `f9442ef` providers · `4d314b1` worker · `c418fc6` panel · `d90dd01` integration+gate · `ad35f3b` env docs |

**Verified baseline (on the identical `ad35f3b`/`be20dd5` tree):** `npm run verify` → **exit 0, 1,089 passed / 1 skipped (pre-existing), Next build compiled** (clean rebuilt LITE DB). Mock seed exit 0. External-confluence gate script (`scripts/confluence-gate.mjs`) → exit 0, all 5 checks PASS.

## 4. Current capabilities

- **Wallet-driven smart-money detection** (Solana-first): CSV import, FIFO PnL, wallet scoring, signal rules A–G, FlowScore, aggregation + signal job, Telegram alert sender + cooldowns, Alerts/Settings pages.
- **Graph & money-flow analysis:** BFS wallet graph, link confidence + clustering, money flow / bridge / rotation, Wallet Graph + Money Flow pages, exports.
- **Live Solana providers:** Helius adapter (with the F9 large-account graceful-degrade), DexScreener market data; address registry + tagging; discovery/stats jobs.
- **Connectors + candidates:** connector framework + mock source, candidate validation/promotion, live connector adapters + Source Health page, Dune connector framework + overlap import (query templates only — **no fresh execution**), multi-token Wallet Overlap Finder.
- **Backtest & shadow:** signal-outcome evaluator, no-lookahead historical replay, threshold tuning / walk-forward, shadow-mode tracker, Backtest & Shadow pages, Signal/Alpha Feed landing.
- **Social intelligence (shadow-only):** Telegram/Discord inbound readers (config-gated), token-mention extraction/velocity/spam filtering, `/social` page + source management, token-detail social section, wallet-signal confluence overlap.
- **External confluence (shadow-only):** deterministic internal **LiquidityRisk** (CPMM identities + CLMM caveats, no key required) computed for every token with market data; **HolderScan / CLOBr / GMGN / AG Paper** provider stubs; `externalConfluence` worker pass; token-detail **Confluence panel** (conflict-aware, provider-claimed labeling).

## 5. What is shadow-only

Both post-MVP tracks are **evidence/confluence only** — recorded and displayed, never fed into scoring or acted upon:

- **Social intelligence** — mentions/velocity/overlap are surfaced alongside wallet signals; they do **not** feed FlowScore, the signal rules, or alerts, and mentions **never create Token rows**.
- **External confluence** — LiquidityRisk + all provider snapshots render in the Confluence panel labeled `shadow-only`, `provider-claimed` (vs internal-computed), and **"not part of FlowScore"**; disagreement between sources is surfaced, not just confirmation. External providers **never create Token rows**; unavailable/missing/stub states render honestly and are **never** shown as "safe".

**Unchanged by both tracks:** FlowScore formulas, signal thresholds, wallet scoring, and CandidateWallet validation/promotion.

## 6. Not yet live — needs API/access

These ship today as honest, config-gated stubs (build is green with **zero** keys); each becomes live only when real access is available:

- **Telegram / Discord real groups (social sources)** — inbound readers are built and config-gated behind `SOCIAL_TELEGRAM_READ_TOKEN` / `SOCIAL_DISCORD_BOT_TOKEN`; no real group links are wired yet. Missing token ⇒ stub returns `[]`, no endpoints called.
- **HolderScan key/plan** — `HOLDERSCAN_API_KEY` optional; likely paid/plan-gated. Missing key ⇒ `missing_key` skip; keyed ⇒ documented stub reporting `plan_required`/`unavailable`. Holder data being unavailable is **never** treated as safe. (A real fetch will require an HTTP 402/403 → `plan_required` mapping test — noted in the plan.)
- **CLOBr API confirmation** — no confirmed public API/docs; ships as a `stub` (no scraping of gated content) until an API is confirmed.
- **GMGN query-only API** — `GMGN_API_KEY` optional; **query-only** (no swap/order/private-key/wallet/execution — enforced by a grep-guard test + the gate script). Ships as a `stub`/status adapter until query-only endpoints/docs are confirmed.
- **AG Paper Trading** — manual/stub-only; a CSV import shape is documented in the adapter comment, but no automation/parser is built (no Telegram bot control).

## 7. Operational notes

- **`.env` is gitignored** (confirmed via `git check-ignore .env`); only `.env.example` is tracked. No secrets are committed; `apiKeyEnvName` stores env-var **names** only, never values.
- **`DUNE_EXECUTE_FRESH=false`** (default in `.env.example`). No fresh Dune query execution; Dune usage is query-template/import only. External-confluence code references zero Dune paths (gate CHECK 4).
- **No BSC** in the post-MVP tracks. The schema stays chain-aware via `ChainId`, but social + external-confluence operate Solana-only in practice; no BSC fetch logic was added.
- **No trading/execution anywhere.** No order/swap/signing surface; GMGN is query-only; AG Paper is observation-only. All external data is analytics/evidence.

## 8. Next recommended branches (when access is available)

Branch fresh from `main` @ `be20dd5` for each:

- **`feat/social-live-sources`** — wire real Telegram/Discord group readers behind the existing config gates (needs `SOCIAL_TELEGRAM_READ_TOKEN` / `SOCIAL_DISCORD_BOT_TOKEN` + real group links). Stays shadow-only.
- **`feat/holderscan-live`** — implement the real HolderScan fetch (needs key + plan); add the mandatory 401/403/402 → `plan_required` and 429 → `rate_limited` HTTP-mapping tests. Stays shadow-only.
- **`feat/gmgn-query-live`** — implement the real GMGN **query-only** adapter once endpoints/docs are confirmed; the query-only grep-guard + gate check must remain green (no swap/order/key/execution). Stays shadow-only.

(Deliberately **not** recommended now: CLOBr live — no confirmed API; BSC — out of scope; Dune fresh execution — kept off.)

## 9. Final recommendation

**Run `npm run verify` on a clean/rebuilt LITE DB (expect 1,089 passed / 1 skipped, Next build compiled), confirm green, then stop feature coding until real source/API inputs are available.** Everything mergeable without external access is now on `main`; the remaining work (social live sources, HolderScan, GMGN) is blocked on credentials/API confirmation, not on engineering. Resuming before those inputs exist would only add more stubs against unverified contracts.

---

*This is a documentation-only checkpoint. No code changed, no tags moved, no BSC, no Dune fresh execution, no secrets committed.*
