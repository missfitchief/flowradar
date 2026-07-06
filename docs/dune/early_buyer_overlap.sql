-- early_buyer_overlap.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: wallets that bought MULTIPLE of the selected tokens EARLY (within a configurable
-- window of each token's first observed trade), not just at any point in the range.
--
-- Params (must match FlowRadar's DuneClient query_parameters keys EXACTLY — see
-- packages/db/src/dune/duneOverlap.ts's runTokenOverlapSearch, the source of truth for what
-- this connector actually sends. If you rename a param here, update that file too):
--   {{token_address_1}} .. {{token_address_5}} - token contract addresses to check (2-5 sent;
--                                                 unused slots bound to null, filtered by `in`)
--   {{chain}}               - chain scope, e.g. 'solana'
--   {{min_trade_usd}}       - minimum trade size in USD (filters dust)
--   {{min_tokens_overlap}}  - minimum distinct-token count required to count as "multiple"
--   {{start_time}}, {{end_time}} - time window bounds (optional; only sent when provided)

with token_launch as (
    select
        t.token_bought_address as token_address,
        min(t.block_time)      as launch_time
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in (
            {{token_address_1}}, {{token_address_2}}, {{token_address_3}},
            {{token_address_4}}, {{token_address_5}}
          )  -- unused slots should be bound to null in Dune's query editor
      and t.blockchain = {{chain}}
      and t.block_time between {{start_time}} and {{end_time}}
    group by t.token_bought_address
),

early_trades as (
    select
        t.trader_id            as wallet_address,
        t.token_bought_address  as token_address,
        t.block_time            as trade_time,
        t.amount_usd            as trade_usd,
        l.launch_time
    from solana.dex.trades t
    join token_launch l on l.token_address = t.token_bought_address
    where t.blockchain = {{chain}}
      and t.amount_usd >= {{min_trade_usd}}
      and t.block_time between l.launch_time and l.launch_time + interval '24' hour  -- "early" window, tune as needed
),

wallet_early_overlap as (
    select
        wallet_address,
        count(distinct token_address) as tokens_bought_early_count,
        min(trade_time)               as first_early_buy_time,
        sum(trade_usd)                as total_early_buy_usd
    from early_trades
    group by wallet_address
    having count(distinct token_address) >= {{min_tokens_overlap}}
)

select
    wallet_address,
    {{chain}}                as chain,
    tokens_bought_early_count,
    first_early_buy_time,
    total_early_buy_usd
from wallet_early_overlap
order by tokens_bought_early_count desc, total_early_buy_usd desc;
