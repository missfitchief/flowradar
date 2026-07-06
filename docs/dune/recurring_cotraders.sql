-- recurring_cotraders.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: find pairs/groups of wallets that repeatedly co-buy the same tokens within a short
-- window of each other across MULTIPLE distinct tokens — a signal of a coordinated group or
-- copy-trading relationship, feeding entity-cluster research (see Spec §6 linkConfidence).
--
-- Params:
--   {{token_1}}, {{token_2}}, {{token_3}} - token contract addresses to scope the search to
--   {{chain}}                            - chain scope, e.g. 'solana'
--   {{min_trade_usd}}                    - minimum trade size in USD (filters dust)
--   {{start_time}}, {{end_time}}         - time window bounds

with scoped_trades as (
    select
        t.trader_id            as wallet_address,
        t.token_bought_address  as token_address,
        t.block_time            as trade_time,
        t.amount_usd            as trade_usd
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in ({{token_1}}, {{token_2}}, {{token_3}})
      and t.blockchain = {{chain}}
      and t.amount_usd >= {{min_trade_usd}}
      and t.block_time between {{start_time}} and {{end_time}}
),

cotrade_pairs as (
    -- pair up wallets that bought the SAME token within a short window of each other
    select
        a.wallet_address as wallet_a,
        b.wallet_address as wallet_b,
        a.token_address  as token_address,
        a.trade_time     as trade_time_a,
        b.trade_time     as trade_time_b
    from scoped_trades a
    join scoped_trades b
      on a.token_address = b.token_address
     and a.wallet_address < b.wallet_address   -- avoid duplicate/self pairs
     and abs(extract(epoch from (a.trade_time - b.trade_time))) <= 3600  -- co-trade window, tune as needed
),

recurring_pairs as (
    select
        wallet_a,
        wallet_b,
        count(distinct token_address) as shared_tokens_count,
        min(least(trade_time_a, trade_time_b))  as first_cotrade_time,
        max(greatest(trade_time_a, trade_time_b)) as last_cotrade_time
    from cotrade_pairs
    group by wallet_a, wallet_b
    having count(distinct token_address) >= 2   -- "recurring" = co-traded across at least 2 tokens
)

select
    wallet_a,
    wallet_b,
    {{chain}}             as chain,
    shared_tokens_count,
    first_cotrade_time,
    last_cotrade_time
from recurring_pairs
order by shared_tokens_count desc;
