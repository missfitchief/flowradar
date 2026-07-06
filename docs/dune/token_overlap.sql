-- token_overlap.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: find wallets that traded ALL of the selected tokens (up to 3 in this template;
-- extend the CTE + HAVING count if you need more than 3 in your saved query).
--
-- Params (bind these in Dune's query editor to match the {{...}} placeholders):
--   {{token_1}}, {{token_2}}, {{token_3}} - token contract addresses to check for overlap
--   {{chain}}                            - chain scope, e.g. 'solana'
--   {{min_trade_usd}}                    - minimum trade size in USD (filters dust)
--   {{start_time}}, {{end_time}}         - time window bounds

with token_traders as (
    select
        t.trader_id           as wallet_address,
        t.token_bought_address as token_address,
        t.block_time           as trade_time,
        t.amount_usd           as trade_usd
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in ({{token_1}}, {{token_2}}, {{token_3}})
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
    having count(distinct token_address) = 3   -- N = number of tokens passed in; set to match param count
)

select
    wallet_address,
    {{chain}}                as chain,
    tokens_overlap_count,
    first_buy_time,
    total_buy_usd
from wallet_token_overlap
order by total_buy_usd desc;
