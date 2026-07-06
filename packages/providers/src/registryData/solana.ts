// FlowRadar — curated static AddressRegistry seed data: Solana (Task 26).
//
// This is a STARTING registry, not a complete or authoritative one. It exists
// so the BFS/clustering engines have *some* real-world do-not-expand/CEX/
// router/bridge coverage on day one of live-provider mode, not so operators
// never need to touch it again. Fewer-but-correct beats many-but-wrong: every
// entry below is a well-known, widely-documented Solana program/mint address
// the author is confident in; anything not confidently known was deliberately
// left out rather than guessed. Operators should extend this list via a
// future admin UI (see task-26-report.md for the per-entry confidence basis)
// rather than treating it as exhaustive — it deliberately does NOT attempt to
// enumerate every CEX hot wallet, every AMM pool, or every bridge route.
//
// Shape: { address, category, label, source: 'static-2026-07', doNotExpand }.
// ROUTER/BRIDGE/POOL/TOKEN_CONTRACT/MIXER entries are programs/mints, so
// doNotExpand is always true for them (there is no "counterparty wallet"
// behind a program address worth walking further). CEX entries are hot
// wallets, not programs, but are still doNotExpand:true — expanding past a
// CEX hot wallet walks into the exchange's internal wallet-shuffling, which
// is not useful for tracing an external actor's fund flow (matches the
// existing mock-world convention in packages/db/src/seed.ts).

export interface StaticRegistryEntry {
  address: string;
  category: 'CEX' | 'BRIDGE' | 'ROUTER' | 'POOL' | 'DEPLOYER' | 'MIXER' | 'TOKEN_CONTRACT';
  label: string;
  source: 'static-2026-07';
  doNotExpand: boolean;
}

export const SOLANA_STATIC_REGISTRY: StaticRegistryEntry[] = [
  // -- ROUTER: DEX aggregators / AMM program ids --------------------------
  {
    address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    category: 'ROUTER',
    label: 'Jupiter Aggregator v6',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    category: 'ROUTER',
    label: 'Raydium AMM v4',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    category: 'ROUTER',
    label: 'Orca Whirlpool',
    source: 'static-2026-07',
    doNotExpand: true
  },

  // -- BRIDGE: Wormhole program ids ----------------------------------------
  {
    address: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',
    category: 'BRIDGE',
    label: 'Wormhole Token Bridge',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
    category: 'BRIDGE',
    label: 'Wormhole Core Bridge',
    source: 'static-2026-07',
    doNotExpand: true
  },

  // -- TOKEN_CONTRACT: major stablecoin mints ------------------------------
  {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    category: 'TOKEN_CONTRACT',
    label: 'USDC (Solana mint)',
    source: 'static-2026-07',
    doNotExpand: true
  },
  {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    category: 'TOKEN_CONTRACT',
    label: 'USDT (Solana mint)',
    source: 'static-2026-07',
    doNotExpand: true
  }

  // -- CEX: intentionally empty for this starting list ---------------------
  // TODO(operator): add well-known exchange hot-wallet addresses here (e.g.
  // Binance/Coinbase/Bybit Solana deposit/hot wallets) once confirmed against
  // a current, authoritative source — exchange hot wallets rotate more often
  // than program ids and are easy to get subtly wrong from memory alone, so
  // none are hard-coded in this starting registry. Fewer-but-correct: no
  // Solana CEX address is included here rather than risk mislabeling an
  // address that isn't actually exchange-controlled.
];
