-- recurring_cotraders.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: find pairs/groups of wallets that repeatedly co-buy the same tokens within a short
-- window of each other across MULTIPLE distinct tokens — a signal of a coordinated group or
-- copy-trading relationship, feeding entity-cluster research (see Spec §6 linkConfidence).
--
-- Params (must match FlowRadar's DuneClient query_parameters keys EXACTLY — see
-- packages/db/src/dune/duneOverlap.ts's runTokenOverlapSearch, the source of truth for what
-- this connector actually sends. If you rename a param here, update that file too):
--   {{token_address_1}} .. {{token_address_5}} - token contract addresses to scope the search
--                                                 to (2-5 sent; unused slots bound to null,
--                                                 filtered by `in`)
--   {{chain}}               - chain scope, e.g. 'solana'
--   {{min_trade_usd}}       - minimum trade size in USD (filters dust)
--   {{min_tokens_overlap}}  - minimum distinct shared-token count required to count as "recurring"
--   {{start_time}}, {{end_time}} - time window bounds (optional; only sent when provided)

with scoped_trades as (
    select
        t.trader_id            as wallet_address,
        t.token_bought_address  as token_address,
        t.block_time            as trade_time,
        t.amount_usd            as trade_usd
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where t.token_bought_address in (
            {{token_address_1}}, {{token_address_2}}, {{token_address_3}},
            {{token_address_4}}, {{token_address_5}}
          )  -- unused slots should be bound to null in Dune's query editor
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
    having count(distinct token_address) >= {{min_tokens_overlap}}
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
