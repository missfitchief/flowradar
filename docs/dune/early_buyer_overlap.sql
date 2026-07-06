-- early_buyer_overlap.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: wallets that bought MULTIPLE of the selected tokens EARLY (within a configurable
-- window of each token's first observed trade), not just at any point in the range.
--
-- Params:
--   {{token_1}}, {{token_2}}, {{token_3}} - token contract addresses to check
--   {{chain}}                            - chain scope, e.g. 'solana'
--   {{min_trade_usd}}                    - minimum trade size in USD (filters dust)
--   {{start_time}}, {{end_time}}         - time window bounds

with token_launch as (
    select
        t.token_bought_address as token_address,
        min(t.block_time)      as launch_time
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in ({{token_1}}, {{token_2}}, {{token_3}})
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
    having count(distinct token_address) >= 2   -- "multiple" = at least 2 of the selected tokens
)

select
    wallet_address,
    {{chain}}                as chain,
    tokens_bought_early_count,
    first_early_buy_time,
    total_early_buy_usd
from wallet_early_overlap
order by tokens_bought_early_count desc, total_early_buy_usd desc;
