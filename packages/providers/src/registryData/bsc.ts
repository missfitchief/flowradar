// FlowRadar — curated static AddressRegistry seed data: BSC (Task 26).
//
// Same "starting registry, not exhaustive" contract as ./solana.ts — see that
// file's header for the full fewer-but-correct rationale. Every address below
// is stored LOWERCASE per this repo's BSC address convention (see
// packages/providers/src/mock/address.ts's fakeBscAddress: BSC addresses are
// 0x + lowercase hex throughout this codebase).

import type { StaticRegistryEntry } from './solana';

export const BSC_STATIC_REGISTRY: StaticRegistryEntry[] = [
  // -- ROUTER: DEX router contracts ----------------------------------------
  {
    address: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
    category: 'ROUTER',
    label: 'PancakeSwap v2 Router',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    category: 'ROUTER',
    label: 'PancakeSwap v3 SmartRouter',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: '0x1111111254eeb25477b68fb85ed929f73a960582',
    category: 'ROUTER',
    label: '1inch v5 Router',
    source: 'static-2026-07',
    doNotExpand: true
  },

  // -- BRIDGE ---------------------------------------------------------------
  {
    address: '0x8731d54e9d02c286767d56ac03e8037c07e01e98',
    category: 'BRIDGE',
    label: 'Stargate Router',
    source: 'static-2026-07',
    doNotExpand: true
  },

  // -- TOKEN_CONTRACT: major token contracts --------------------------------
  {
    address: '0x55d398326f99059ff775485246999027b3197955',
    category: 'TOKEN_CONTRACT',
    label: 'USDT (BSC, BEP-20)',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    category: 'TOKEN_CONTRACT',
    label: 'USDC (BSC, BEP-20)',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: '0xbb4cdb9cbd36b01bd1cbaef60af814a3f6f0ee75',
    category: 'TOKEN_CONTRACT',
    label: 'WBNB',
    source: 'static-2026-07',
    doNotExpand: true
  },

  // -- CEX: well-known Binance hot wallet(s) ---------------------------------
  {
    address: '0xf977814e90da44bfa03b6295a0616a897441acec',
    category: 'CEX',
    label: 'Binance 8 (hot wallet)',
    source: 'static-2026-07',
    doNotExpand: true
  }

  // TODO(operator): add further exchange hot wallets (Coinbase, Bybit, OKX,
  // etc.) once confirmed against a current, authoritative source. Only one
  // Binance hot wallet is included here — fewer-but-correct — rather than
  // padding this list with addresses recalled from memory but not verified.
];
