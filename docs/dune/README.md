# Dune query connector — setup and policy

FlowRadar's Wave 4.6 Dune connector uses **Dune saved queries + the Dune API** as a bootstrap/backfill
source for multi-token wallet overlap and smart-wallet discovery. It is not a replacement for the
30–60s tracked-wallet monitoring loop — live alerts still come only from FlowRadar's own
tracked-wallet pipeline. Rows returned by Dune are never trusted blindly: they enter the system as
`CandidateWallet` rows (`source=dune_token_overlap`) and must pass the same validation/promotion
gate as every other connector (see `packages/core/src/candidates/validate.ts` and Spec §5b/§5d)
before they can influence any signal, score, or count.

## 1. Data-access priority (binding)

1. **Dune saved queries + Dune API** — primary, documented, credit-metered.
2. **Frontend scraping** — fallback-only, and **disabled by default**. FlowRadar does not rely on
   fragile scraping of the Dune web UI; it is not wired up unless explicitly enabled in a future
   change, and this repo ships no scraping code.

## 2. Saved-query setup (one-time, per template)

The SQL files in this directory are **templates**, not runnable queries. Dune executes only
**saved queries** that exist in your Dune account. For each template you want to use:

1. Open https://dune.com/queries and create a new query.
2. Paste the template SQL, adapting table/column names to the current Dune schema (each file's
   header comment flags this — e.g. `solana.dex.trades` may not be the exact table name by the
   time you set this up; check Dune's schema browser first).
3. Add the query's parameters in Dune's UI so they match the `{{param}}` placeholders used in the
   template (see §3).
4. Save the query and copy its numeric **query ID** from the URL.
5. Put that ID in a `DuneQuerySource.queryId` row (or in `DUNE_DEFAULT_OVERLAP_QUERY_ID` in
   `.env` for the default overlap query used by the Overlap Finder UI).

Until a template has been turned into a real saved query with a valid `queryId`, the connector
reports `status: missing_key` / `stub` and the app falls back to mock data — it never crashes.

## 3. Parameter binding

Templates use Dune's `{{param}}` binding syntax. FlowRadar's client fills these binding names:

| Placeholder | Meaning |
|---|---|
| `{{token_1}}`, `{{token_2}}`, `{{token_3}}` | Up to 3 (of the 2–5 supported) token contract addresses to check for overlap. |
| `{{chain}}` | Chain scope, e.g. `solana` or `bsc`. |
| `{{min_trade_usd}}` | Minimum trade size in USD to count as a real trade (filters out dust). |
| `{{start_time}}` / `{{end_time}}` | Time window bounds (ISO timestamps) for the query. |

The Overlap Finder UI currently accepts 2–5 token CAs; the shipped templates bind 3 explicit slots
(`token_1..3`) as the common case — extend the saved query's parameter list if you need more.

## 4. Cached vs. fresh execution (credit policy)

Dune bills credits per query **execution**, not per read of a cached result. FlowRadar defaults to
the credit-safe path:

- `DUNE_USE_LATEST_RESULT=true` (default) — the client fetches the query's **latest cached
  result** and never triggers a new execution. This is free (or near-free) and is the right choice
  for routine polling.
- `DUNE_EXECUTE_FRESH=false` (default) — fresh (paid) execution is **off**. Set this to `true`
  only when you deliberately want up-to-the-minute data and are prepared for it to consume Dune
  credits. When both envs allow it, the client executes, polls the execution status, then fetches
  results.

Never flip `DUNE_EXECUTE_FRESH=true` as a default for automated/scheduled jobs — it will burn
credits every poll cycle. Use it for manual, on-demand refreshes only.

## 5. Templates in this directory

| File | Purpose |
|---|---|
| `token_overlap.sql` | Wallets that traded **all** of the selected tokens (the core overlap-finder query). |
| `early_buyer_overlap.sql` | Wallets that bought **multiple** of the selected tokens **early**. |
| `recurring_cotraders.sql` | Repeat co-buyer pairs/groups trading together across short windows. |
| `token_top_traders.sql` | Top profitable traders for a single token (backfill source). |

All four are illustrative/conceptual SQL — adapt table and column names to whatever the current
Dune schema uses at setup time (Dune's underlying decoded-table names change over time). None of
these are runnable as-is without being saved as a Dune query first (§2).
