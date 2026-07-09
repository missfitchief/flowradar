-- solana_wallet_pnl_30d.sql
--
-- ILLUSTRATIVE / SECONDARY, NOT WIRED. Like `token_top_traders.sql`, this template is
-- NOT connected to any FlowRadar connector — it is a starting point for a Dune SAVED
-- QUERY you fork/author yourself and then read CACHED (see docs/dune/README.md §4 and
-- `packages/providers/src/candidates/dune/client.ts`; DUNE_EXECUTE_FRESH stays false).
-- Dune is only the *secondary cross-check* for wallet sourcing — the primary source is
-- Solana Tracker's native realized-PnL leaderboard (see docs/WALLET_SOURCING_RESEARCH.md).
--
-- ⚠ CAVEATS (read before trusting a single number):
--   1. This computes an APPROXIMATE "net realized USD" = sum(sell USD) − sum(buy USD) per
--      wallet over the window. That is NOT true FIFO cost-basis realized PnL — it ignores
--      open inventory, cost-basis lot matching, fees, and wash/arb trades. FlowRadar's own
--      `computeFifoPnl` (packages/core/src/pnl/fifo.ts) is the correct method; use this only
--      to DISCOVER candidate addresses, then verify each on-chain via Helius/FIFO (Phase 3).
--   2. `dex_solana.trades` schema/table name drifts — VERIFY column/table names in Dune's
--      schema browser before saving (per docs/dune/README.md §2). Adjust as needed.
--   3. A wallet whose PnL is dominated by one token, or with impossibly high ROI, must be
--      excluded downstream (Phase-2 filter), not trusted from this query alone.
--
-- Parameters (bind these in Dune's query editor; names are illustrative — this template is
-- not sent by the connector, so you may rename freely for a manual/cached saved query):
--   {{chain}}            -- 'SOLANA' (kept for symmetry with other templates)
--   {{start_time}}       -- ISO timestamp, window start (e.g. now() - interval '30' day)
--   {{end_time}}         -- ISO timestamp, window end (e.g. now())
--   {{min_realized_usd}} -- e.g. 4000 : minimum approx net realized USD to keep
--   {{min_trades}}       -- e.g. 20   : minimum trade count in the window
--   {{max_results}}      -- e.g. 500  : LIMIT cap for manual UI runs

with trades_win as (
    select
        trader_id                                              as wallet_address,
        token_bought_amount,
        token_sold_amount,
        amount_usd,
        -- classify each leg relative to the wallet: a "sell" realizes USD, a "buy" spends it.
        case when token_sold_amount   > 0 then amount_usd else 0 end as sell_usd,
        case when token_bought_amount > 0 then amount_usd else 0 end as buy_usd,
        block_time
    from dex_solana.trades
    where block_time >= cast('{{start_time}}' as timestamp)
      and block_time <  cast('{{end_time}}'   as timestamp)
      and amount_usd is not null
),

per_wallet as (
    select
        wallet_address,
        sum(sell_usd)                       as gross_sold_usd,
        sum(buy_usd)                        as gross_bought_usd,
        sum(sell_usd) - sum(buy_usd)        as approx_net_realized_usd,   -- ⚠ approximation, not FIFO
        sum(amount_usd)                     as volume_usd,
        count(*)                            as trade_count,
        count(distinct date_trunc('day', block_time)) as active_days,
        max(block_time)                     as last_active
    from trades_win
    group by 1
)

select
    wallet_address,
    'SOLANA'                                            as chain,           -- provider-claimed source scope
    round(approx_net_realized_usd, 2)                   as approx_realized_pnl_30d_usd,
    round(volume_usd, 2)                                as volume_30d_usd,
    trade_count                                         as trade_count_30d,
    active_days                                         as active_days_30d,
    round(volume_usd / nullif(trade_count, 0), 2)       as avg_trade_size_usd,
    last_active
from per_wallet
where approx_net_realized_usd >= cast('{{min_realized_usd}}' as double)
  and trade_count             >= cast('{{min_trades}}'       as integer)
  and volume_usd > 0
order by approx_realized_pnl_30d_usd desc
limit {{max_results}}
;
