-- token_overlap.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: find wallets that traded ALL of the selected tokens (2-5 tokens — the Overlap
-- Finder UI accepts 2-5 token CAs, and FlowRadar's connector sends one {{token_address_N}}
-- per address given, N = 1..5, so this template binds all 5 slots and treats an unused slot
-- as null, filtered out of the `in (...)` list below).
--
-- Params (these placeholder names MUST match FlowRadar's DuneClient query_parameters keys
-- EXACTLY — see packages/db/src/dune/duneOverlap.ts's runTokenOverlapSearch, the source of
-- truth for what this connector actually sends. If you rename a param here, update that file
-- too):
--   {{token_address_1}} .. {{token_address_5}} - token contract addresses to check for overlap.
--                                                 Only as many as the search has (2-5) are sent
--                                                 non-null; bind the rest to Dune's null/blank
--                                                 default so this template works for any count.
--   {{chain}}               - chain scope, e.g. 'solana' (string param, quote it in the WHERE)
--   {{min_trade_usd}}       - minimum trade size in USD (filters dust)
--   {{min_tokens_overlap}}  - minimum distinct-token overlap count required (HAVING threshold)
--   {{max_results}}         - NOTE: the connector does NOT send this as a query_parameter — it
--                             passes it as ExecuteQueryOpts.limit, which the Dune API client
--                             applies as the `limit` URL query param on the results-fetch call
--                             (GET .../results?limit=N), not a SQL placeholder. Bind
--                             {{max_results}} here ONLY if you also want an in-query LIMIT as a
--                             defense-in-depth cap for ad-hoc runs in the Dune UI; the connector
--                             will still apply its own `limit` on top when fetching results.
--   {{start_time}}, {{end_time}} - time window bounds (optional; only sent when provided)

with token_traders as (
    select
        t.trader_id           as wallet_address,
        t.token_bought_address as token_address,
        t.block_time           as trade_time,
        t.amount_usd           as trade_usd
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in (
            {{token_address_1}}, {{token_address_2}}, {{token_address_3}},
            {{token_address_4}}, {{token_address_5}}
          )  -- unused slots should be bound to null in Dune's query editor; `in (...)` ignores nulls
      and t.blockchain = {{chain}}
      and t.amount_usd >= {{min_trade_usd}}
      and t.block_time between {{start_time}} and {{end_time}}
),

wallet_token_overlap as (
    select
        wallet_address,
        count(distinct token_address) as tokens_overlap_count,
        min(trade_time)               as first_buy_time,
        sum(trade_usd)                as total_buy_usd
    from token_traders
    group by wallet_address
    having count(distinct token_address) >= {{min_tokens_overlap}}
)

select
    wallet_address,
    {{chain}}                as chain,
    tokens_overlap_count,
    first_buy_time,
    total_buy_usd
from wallet_token_overlap
order by total_buy_usd desc
limit {{max_results}};
