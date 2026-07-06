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
   template (see §3). These placeholder names MUST match FlowRadar's DuneClient
   `query_parameters` keys EXACTLY — see `packages/providers/src/candidates/dune/` (the client)
   and `packages/db/src/dune/duneOverlap.ts` (the caller that builds the params object) as the
   source of truth. If you rename a parameter in the saved query, update the connector too (or
   the live run will send a key the saved query doesn't recognize and Dune will error/ignore it).
4. Save the query and copy its numeric **query ID** from the URL.
5. Put that ID in a `DuneQuerySource.queryId` row (or in `DUNE_DEFAULT_OVERLAP_QUERY_ID` in
   `.env` for the default overlap query used by the Overlap Finder UI).

Until a template has been turned into a real saved query with a valid `queryId`, the connector
reports `status: missing_key` / `stub` and the app falls back to mock data — it never crashes.

## 3. Parameter binding

Templates use Dune's `{{param}}` binding syntax. These placeholder names MUST match FlowRadar's
`DuneClient` `query_parameters` keys **exactly** — see `packages/providers/src/candidates/dune/`
(client + types, the source of truth for what the connector sends) and
`packages/db/src/dune/duneOverlap.ts`'s `runTokenOverlapSearch` (which builds the actual params
object for every live/mock overlap search). If you rename a param in the saved query, update the
connector too.

| Placeholder | Meaning | Always sent? |
|---|---|---|
| `{{token_address_1}}` .. `{{token_address_5}}` | One per token CA in the search (2–5, per the Overlap Finder UI's own 2–5 limit). Only as many keys as there are addresses are sent — e.g. a 2-token search sends `token_address_1`/`token_address_2` only, no `token_address_3..5` keys at all. Bind unused slots to null/blank in Dune's query editor so a template written for 5 slots still works for a 2-token search. | Yes (count varies 2–5) |
| `{{chain}}` | Chain scope: `SOLANA` or `BSC` (sent as the `Chain` enum value, uppercase — match casing or lower() it in your WHERE clause). | Yes |
| `{{min_trade_usd}}` | Minimum trade size in USD to count as a real trade (filters out dust). Defaults to `0` if the caller didn't specify one. | Yes |
| `{{min_tokens_overlap}}` | Minimum distinct-token overlap count required. Defaults to `2`, or the number of token addresses in the search, depending on caller (the `/api/overlap` route defaults it to `tokenAddresses.length`). | Yes |
| `{{start_time}}` / `{{end_time}}` | Time window bounds (ISO timestamps). | Only when the caller supplies them — omitted from `query_parameters` entirely otherwise, so a saved query with these as required params will fail on a request that didn't set a time window. Make them optional/nullable in Dune's query editor. |

**Not sent as a `query_parameters` key:** `max_results` / a result cap is passed by the connector
as `ExecuteQueryOpts.limit`, which `client.ts` applies as the `limit` **URL query param** on the
results-fetch call (`GET .../query/{id}/results?limit=N` or `GET .../execution/{id}/results?limit=N`) —
it is Dune's own pagination cap, not a SQL `{{...}}` placeholder. `token_overlap.sql` binds an
**optional** `{{max_results}}` placeholder as an in-query `LIMIT` purely as a defense-in-depth cap
for manual runs in the Dune UI; the connector's own `limit` URL param still applies independently
on top of whatever the query itself returns.

The Overlap Finder UI accepts 2–5 token CAs, and the connector sends exactly that many
`token_address_N` keys (not a fixed 3) — the shipped templates bind all 5 possible slots
(`token_address_1..5`) so one saved query handles any search size from 2 to 5 tokens.

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
| `token_top_traders.sql` | Top profitable traders for a single token. **Illustrative only — not wired to any connector**: FlowRadar's actual single-token backfill (`tokenTopTraderBackfillWorker`, `packages/db/src/tokenTopTraderBackfill.ts`) calls the Birdeye provider, not Dune. Kept for manual analysis or as a starting point if a Dune-backed version is added later. |

All four are illustrative/conceptual SQL — adapt table and column names to whatever the current
Dune schema uses at setup time (Dune's underlying decoded-table names change over time). None of
these are runnable as-is without being saved as a Dune query first (§2). The first three
(`token_overlap`, `early_buyer_overlap`, `recurring_cotraders`) are the ones the live connector
actually drives, via `runTokenOverlapSearch`'s `query_parameters` (§3); `token_top_traders` is not
currently invoked by any FlowRadar code path.
