-- token_top_traders.sql
-- TEMPLATE ONLY — not a runnable query. Create this as a saved query in the Dune UI
-- (see docs/dune/README.md) and adapt table/column names to the current Dune schema
-- before use. conceptual logic — adapt table names to current Dune schema (e.g. solana.dex.trades).
--
-- Purpose: top profitable traders for a SINGLE token — a discovery-source idea for seeding
-- CandidateWallet rows from a token's most successful buyers (Spec §5b).
--
-- ILLUSTRATIVE ONLY, NOT WIRED TO THE DUNE CONNECTOR: FlowRadar's actual single-token backfill
-- (packages/db/src/tokenTopTraderBackfill.ts, tokenTopTraderBackfillWorker) calls the Birdeye
-- provider (packages/providers/src/candidates/birdeyeCandidates.ts), NOT Dune — there is no
-- code path in this repo that builds Dune query_parameters for a single-token top-traders
-- query. This template is kept for an operator who wants to run this analysis manually in the
-- Dune UI, or as a starting point if a future Dune-backed top-traders source is added. If you
-- do wire this into a connector, name the query_parameters keys to match this template (or vice
-- versa) and update this header + docs/dune/README.md accordingly.
--
-- Params (illustrative — pick names that suit a manual/future connector; {{token_address_1}}
-- mirrors the naming convention runTokenOverlapSearch uses for its own token slots, see
-- packages/db/src/dune/duneOverlap.ts, for consistency across these templates):
--   {{token_address_1}}          - the single token contract address to analyze
--   {{chain}}                    - chain scope, e.g. 'solana'
--   {{min_trade_usd}}            - minimum trade size in USD (filters dust)
--   {{start_time}}, {{end_time}} - time window bounds

with token_trades as (
    select
        t.trader_id   as wallet_address,
        t.block_time  as trade_time,
        t.amount_usd  as trade_usd,
        t.token_bought_address,
        t.token_sold_address,
        t.price_usd    as trade_price_usd,
        t.tx_hash      as tx_hash
    from solana.dex.trades t          -- conceptual table name, verify against current schema
    where (t.token_bought_address = {{token_address_1}} or t.token_sold_address = {{token_address_1}})
      and t.blockchain = {{chain}}
      and t.amount_usd >= {{min_trade_usd}}
      and t.block_time between {{start_time}} and {{end_time}}
),

wallet_buys as (
    select wallet_address, sum(trade_usd) as total_buy_usd, count(*) as buy_count,
           min(trade_time) as first_buy_time
    from token_trades
    where token_bought_address = {{token_address_1}}
    group by wallet_address
),

wallet_sells as (
    select wallet_address, sum(trade_usd) as total_sell_usd, count(*) as sell_count,
           max(trade_time) as last_sell_time
    from token_trades
    where token_sold_address = {{token_address_1}}
    group by wallet_address
),

wallet_pnl as (
    select
        coalesce(b.wallet_address, s.wallet_address) as wallet_address,
        coalesce(b.total_buy_usd, 0)   as total_buy_usd,
        coalesce(s.total_sell_usd, 0)  as total_sell_usd,
        coalesce(s.total_sell_usd, 0) - coalesce(b.total_buy_usd, 0) as estimated_pnl_usd,
        coalesce(b.buy_count, 0)   as buy_count,
        coalesce(s.sell_count, 0)  as sell_count,
        b.first_buy_time,
        s.last_sell_time
    from wallet_buys b
    full outer join wallet_sells s on s.wallet_address = b.wallet_address
)

select
    wallet_address,
    {{chain}}          as chain,
    {{token_address_1}} as token_address,
    total_buy_usd,
    total_sell_usd,
    estimated_pnl_usd,
    buy_count,
    sell_count,
    first_buy_time,
    last_sell_time
from wallet_pnl
order by estimated_pnl_usd desc;
