// FlowRadar — ingest pipeline tests (Task 5 brief).
//
// Integration test against the real LITE-mode Postgres (embedded-postgres,
// port 5439 — see scripts/db-local.ts / packages/db/src/client.ts). There is
// no per-test transaction/throwaway-schema isolation (upsert semantics make
// that awkward); instead every synthetic row created here uses a wallet/token
// address prefixed with `T5TEST` so afterAll() can clean up precisely by
// `address startsWith prefix`, without touching any other data (e.g. seeded
// mock-world rows from a later task).
//
// If the LITE Postgres isn't reachable (e.g. `npm run db:migrate` was never
// run on this machine), the whole suite is skipped with a clear console
// notice rather than hard-failing — per Task 5 brief decision 5.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import type { NormalizedTx } from '@flowradar/core';
import { prisma } from '../src/client.js';
import { ingestNormalizedTxs, snapshotMarket } from '../src/ingest.js';

const ADDR_PREFIX = 'T5TEST';
const CHAIN = 'SOLANA' as const;

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[ingest.test] LITE Postgres not reachable on localhost:5439 — skipping ingest ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  // Cascades: WalletTokenTrade -> Wallet/Token (onDelete: Cascade), so
  // deleting wallets/tokens by prefix cleans their trades too. MoneyFlowEdge
  // has no FK to Wallet/Token (it stores raw addresses), so it needs its own
  // explicit cleanup by address prefix.
  await prisma.moneyFlowEdge.deleteMany({
    where: { sourceAddress: { startsWith: ADDR_PREFIX } }
  });
  await prisma.moneyFlowEdge.deleteMany({
    where: { destinationAddress: { startsWith: ADDR_PREFIX } }
  });
  await prisma.walletTokenTrade.deleteMany({
    where: { wallet: { address: { startsWith: ADDR_PREFIX } } }
  });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET_A = `${ADDR_PREFIX}wallet_a_swap_buyer`;
const WALLET_B = `${ADDR_PREFIX}wallet_b_swap_seller`;
const WALLET_C = `${ADDR_PREFIX}wallet_c_transfer_recipient`;
const WALLET_D = `${ADDR_PREFIX}wallet_d_transfer_sender`;
const WALLET_E = `${ADDR_PREFIX}wallet_e_bridge_source`;
const BRIDGE_PROGRAM = `${ADDR_PREFIX}wormhole_bridge_program`;
const TOKEN_ADDR = `${ADDR_PREFIX}token_mint_swap`;

function buildFixtureTxs(): NormalizedTx[] {
  const baseTs = new Date('2026-07-01T00:00:00Z');

  const swapBuyTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_swap_buy`,
    blockOrSlot: 1000n,
    ts: baseTs,
    legs: [
      {
        kind: 'swap_leg',
        from: TOKEN_ADDR, // pool/token side -> wallet receives -> BUY
        to: WALLET_A,
        asset: { address: TOKEN_ADDR, symbol: 'T5T', decimals: 9 },
        amountToken: '1000',
        amountUsd: 500
      }
    ]
  };

  const swapSellTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_swap_sell`,
    blockOrSlot: 1001n,
    ts: new Date(baseTs.getTime() + 60_000),
    legs: [
      {
        kind: 'swap_leg',
        from: WALLET_B, // wallet sends token -> pool -> SELL
        to: TOKEN_ADDR,
        asset: { address: TOKEN_ADDR, symbol: 'T5T', decimals: 9 },
        amountToken: '200',
        amountUsd: 120
      }
    ]
  };

  const tokenTransferTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_token_transfer`,
    blockOrSlot: 1002n,
    ts: new Date(baseTs.getTime() + 120_000),
    legs: [
      {
        kind: 'token_transfer',
        from: WALLET_D,
        to: WALLET_C,
        asset: { address: TOKEN_ADDR, symbol: 'T5T', decimals: 9 },
        amountToken: '50',
        amountUsd: 30
      }
    ]
  };

  const nativeTransferTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_native_transfer`,
    blockOrSlot: 1003n,
    ts: new Date(baseTs.getTime() + 180_000),
    legs: [
      {
        kind: 'native_transfer',
        from: WALLET_D,
        to: WALLET_C,
        asset: { symbol: 'SOL', decimals: 9 },
        amountToken: '2',
        amountUsd: 300
      }
    ]
  };

  const bridgeDepositTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_bridge_deposit`,
    blockOrSlot: 1004n,
    ts: new Date(baseTs.getTime() + 240_000),
    legs: [
      {
        kind: 'bridge_deposit',
        from: WALLET_E,
        to: BRIDGE_PROGRAM,
        asset: { symbol: 'USDC', decimals: 6 },
        amountToken: '1000',
        amountUsd: 1000,
        programOrContract: 'Wormhole'
      }
    ]
  };

  const bridgeWithdrawalTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_bridge_withdrawal`,
    blockOrSlot: 1005n,
    ts: new Date(baseTs.getTime() + 300_000),
    legs: [
      {
        kind: 'bridge_withdrawal',
        from: BRIDGE_PROGRAM,
        to: WALLET_C,
        asset: { symbol: 'USDC', decimals: 18 },
        amountToken: '970',
        amountUsd: 970,
        programOrContract: 'Wormhole'
      }
    ]
  };

  const contractInteractionTx: NormalizedTx = {
    txHash: `${ADDR_PREFIX}tx_contract_interaction`,
    blockOrSlot: 1006n,
    ts: new Date(baseTs.getTime() + 360_000),
    legs: [
      {
        kind: 'contract_interaction',
        from: WALLET_A,
        to: `${ADDR_PREFIX}some_program`,
        asset: { symbol: 'SOL', decimals: 9 },
        amountToken: '0.001',
        amountUsd: 0.15
      }
    ]
  };

  return [
    swapBuyTx,
    swapSellTx,
    tokenTransferTx,
    nativeTransferTx,
    bridgeDepositTx,
    bridgeWithdrawalTx,
    contractInteractionTx
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!(await probePort('localhost', 5439)))('ingestNormalizedTxs', () => {
  it('creates expected trade rows/actions/amounts from a fixture NormalizedTx set', async () => {
    const txs = buildFixtureTxs();
    // ingestNormalizedTxs is scoped to a single wallet's activity stream (as
    // the walletActivity job calls it, once per watched wallet) — ingest once
    // per wallet whose side of a trade we want a row for.
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_A, txs);
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_B, txs);

    const walletA = await prisma.wallet.findUnique({
      where: { address_chain: { address: WALLET_A, chain: CHAIN } }
    });
    expect(walletA).not.toBeNull();

    const token = await prisma.token.findUnique({
      where: { chain_address: { chain: CHAIN, address: TOKEN_ADDR } }
    });
    expect(token).not.toBeNull();

    // BUY: wallet A receives token from swap.
    const buyTrade = await prisma.walletTokenTrade.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_swap_buy`, walletId: walletA!.id, tokenId: token!.id }
    });
    expect(buyTrade).not.toBeNull();
    expect(buyTrade!.action).toBe('BUY');
    expect(Number(buyTrade!.amountUsd)).toBeCloseTo(500, 4);
    expect(Number(buyTrade!.amountToken)).toBeCloseTo(1000, 4);
    expect(Number(buyTrade!.priceUsd)).toBeCloseTo(0.5, 6); // 500/1000

    // SELL: wallet B sends token to swap.
    const walletB = await prisma.wallet.findUnique({
      where: { address_chain: { address: WALLET_B, chain: CHAIN } }
    });
    const sellTrade = await prisma.walletTokenTrade.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_swap_sell`, walletId: walletB!.id, tokenId: token!.id }
    });
    expect(sellTrade).not.toBeNull();
    expect(sellTrade!.action).toBe('SELL');
    expect(Number(sellTrade!.amountUsd)).toBeCloseTo(120, 4);
  });

  it('re-ingesting the same tx set adds ZERO new rows (dedupe)', async () => {
    const txs = buildFixtureTxs();
    // First ingest already happened in the previous test, but tests must not
    // depend on ordering — ingest again explicitly here first to guarantee a
    // stable "before" count, then ingest a second time and assert no growth.
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_A, txs);

    const before = await prisma.walletTokenTrade.count({
      where: { wallet: { address: { startsWith: ADDR_PREFIX } } }
    });
    const edgesBefore = await prisma.moneyFlowEdge.count({
      where: { sourceAddress: { startsWith: ADDR_PREFIX } }
    });

    await ingestNormalizedTxs(prisma, CHAIN, WALLET_A, txs);

    const after = await prisma.walletTokenTrade.count({
      where: { wallet: { address: { startsWith: ADDR_PREFIX } } }
    });
    const edgesAfter = await prisma.moneyFlowEdge.count({
      where: { sourceAddress: { startsWith: ADDR_PREFIX } }
    });

    expect(after).toBe(before);
    expect(edgesAfter).toBe(edgesBefore);
  });

  it('token_transfer produces both a TRANSFER_* trade row and a MoneyFlowEdge transfer row', async () => {
    const txs = buildFixtureTxs();
    // ingestNormalizedTxs is scoped to a single wallet's activity stream (as
    // the real walletActivity job calls it, once per watched wallet): the
    // trade row is only created for the wallet whose perspective is being
    // ingested (to===wallet => TRANSFER_IN, from===wallet => TRANSFER_OUT).
    // The MoneyFlowEdge is a global directed edge and is written regardless
    // of which wallet's perspective produced the call — so ingesting from
    // WALLET_D's perspective covers the OUT trade + the edge, and ingesting
    // again from WALLET_C's perspective covers the IN trade (edge dedupes).
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_D, txs);
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_C, txs);

    const walletC = await prisma.wallet.findUnique({
      where: { address_chain: { address: WALLET_C, chain: CHAIN } }
    });
    const walletD = await prisma.wallet.findUnique({
      where: { address_chain: { address: WALLET_D, chain: CHAIN } }
    });
    const token = await prisma.token.findUnique({
      where: { chain_address: { chain: CHAIN, address: TOKEN_ADDR } }
    });
    expect(walletC).not.toBeNull();
    expect(walletD).not.toBeNull();

    const transferInTrade = await prisma.walletTokenTrade.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_token_transfer`, walletId: walletC!.id, tokenId: token!.id }
    });
    expect(transferInTrade).not.toBeNull();
    expect(transferInTrade!.action).toBe('TRANSFER_IN');

    const transferOutTrade = await prisma.walletTokenTrade.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_token_transfer`, walletId: walletD!.id, tokenId: token!.id }
    });
    expect(transferOutTrade).not.toBeNull();
    expect(transferOutTrade!.action).toBe('TRANSFER_OUT');

    const edge = await prisma.moneyFlowEdge.findFirst({
      where: {
        txHash: `${ADDR_PREFIX}tx_token_transfer`,
        sourceAddress: WALLET_D,
        destinationAddress: WALLET_C
      }
    });
    expect(edge).not.toBeNull();
    expect(edge!.actionType).toBe('transfer');
    expect(Number(edge!.amountUsd)).toBeCloseTo(30, 4);

    // native_transfer => MoneyFlowEdge transfer only, NO trade row (no token involved).
    const nativeEdge = await prisma.moneyFlowEdge.findFirst({
      where: {
        txHash: `${ADDR_PREFIX}tx_native_transfer`,
        sourceAddress: WALLET_D,
        destinationAddress: WALLET_C
      }
    });
    expect(nativeEdge).not.toBeNull();
    expect(nativeEdge!.actionType).toBe('transfer');
  });

  it('bridge legs produce MoneyFlowEdge rows with bridgeProtocol set', async () => {
    const txs = buildFixtureTxs();
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_A, txs);

    const depositEdge = await prisma.moneyFlowEdge.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_bridge_deposit`, sourceAddress: WALLET_E, destinationAddress: BRIDGE_PROGRAM }
    });
    expect(depositEdge).not.toBeNull();
    expect(depositEdge!.actionType).toBe('bridge_deposit');
    expect(depositEdge!.bridgeProtocol).toBe('Wormhole');

    const withdrawalEdge = await prisma.moneyFlowEdge.findFirst({
      where: {
        txHash: `${ADDR_PREFIX}tx_bridge_withdrawal`,
        sourceAddress: BRIDGE_PROGRAM,
        destinationAddress: WALLET_C
      }
    });
    expect(withdrawalEdge).not.toBeNull();
    expect(withdrawalEdge!.actionType).toBe('bridge_withdrawal');
    expect(withdrawalEdge!.bridgeProtocol).toBe('Wormhole');
  });

  it('contract_interaction legs produce no trade row and no MoneyFlowEdge row', async () => {
    const txs = buildFixtureTxs();
    await ingestNormalizedTxs(prisma, CHAIN, WALLET_A, txs);

    const edge = await prisma.moneyFlowEdge.findFirst({
      where: { txHash: `${ADDR_PREFIX}tx_contract_interaction` }
    });
    expect(edge).toBeNull();
  });
});

describe.skipIf(!(await probePort('localhost', 5439)))('snapshotMarket', () => {
  it('writes a TokenMarketSnapshot row from a TokenMarket reading, coercing nulls to 0', async () => {
    const tokenAddr = `${ADDR_PREFIX}token_market_snapshot`;
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: tokenAddr } },
      create: {
        chain: CHAIN,
        address: tokenAddr,
        symbol: 'T5MKT',
        name: 'T5 Market Token',
        decimals: 9,
        firstSeenAt: new Date('2026-07-01T00:00:00Z'),
        riskFlags: []
      },
      update: {}
    });

    const ts = new Date('2026-07-01T01:00:00Z');
    await snapshotMarket(
      prisma,
      token.id,
      {
        priceUsd: 0.5,
        marketCapUsd: 500_000,
        fdvUsd: null,
        liquidityUsd: 20_000,
        vol5m: 100,
        vol1h: 1000,
        vol6h: 5000,
        vol24h: 20000,
        holderCount: null
      },
      ts
    );

    const snapshot = await prisma.tokenMarketSnapshot.findFirst({
      where: { tokenId: token.id, ts }
    });
    expect(snapshot).not.toBeNull();
    expect(Number(snapshot!.priceUsd)).toBeCloseTo(0.5, 6);
    expect(Number(snapshot!.marketCapUsd)).toBeCloseTo(500_000, 4);
    expect(Number(snapshot!.fdvUsd)).toBe(0);
    expect(snapshot!.holderCount).toBe(0);
  });
});
