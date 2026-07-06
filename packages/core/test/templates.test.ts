// FlowRadar — renderAlert template tests (Task 16 TDD).
//
// Snapshot-style exact-string assertions for every template kind (SIGNAL,
// ROTATION, WALLET_GRAPH, TEST) per the Task 16 brief: "Template tests:
// snapshot-style exact-string tests for SIGNAL (NOVA-shaped fixture — assert
// emoji header, entity block lines, escaped `<b>`-safe content, footer),
// ROTATION, WALLET_GRAPH, TEST; escaping test (`symbol: '<EVIL&>'` renders
// escaped)."

import { describe, expect, it } from 'vitest';
import { renderAlert, escapeHtml } from '../src/alerts/templates';
import type {
  SignalAlertData,
  RotationAlertData,
  WalletGraphAlertData,
  TestAlertData,
} from '../src/alerts/templates';

const FOOTER = 'Analytics only — not financial advice.';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes &, <, > in that order (no double-escaping)', () => {
    expect(escapeHtml('<EVIL&>')).toBe('&lt;EVIL&amp;&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('NOVA')).toBe('NOVA');
  });
});

// ---------------------------------------------------------------------------
// SIGNAL — NOVA-shaped fixture (Rule A HIGH per world.meta.scenarios.nova:
// 40 buyers/9-entity cluster readout per Spec §10 "$NOVA ... shows '42
// wallets / 9 entities' style readout")
// ---------------------------------------------------------------------------

function novaFixture(overrides: Partial<SignalAlertData> = {}): SignalAlertData {
  const base: SignalAlertData = {
    severity: 'HIGH',
    symbol: 'NOVA',
    chainName: 'Solana',
    marketCapUsd: 300_000,
    liquidityUsd: 25_000,
    flowScore: 78.8,
    rawWalletCount: 42,
    uniqueEntityCount: 9,
    largestClusterSize: 18,
    clusterConcentration: 'high',
    humanLikePct: 87,
    trackedBuyVolumeUsd: 62_000,
    trackedSellVolumeUsd: 4_000,
    netFlowUsd: 58_000,
    avgSmartEntryMcapUsd: 280_000,
    currentMcapUsd: 300_000,
    reasons: ['42 smart wallets bought within 25 minutes', 'Whale buy of $12,500 detected', '87% of buyers are human_like/smart_money'],
    links: {
      explorerUrl: 'https://solscan.io/account/NOVA_TOKEN_ADDRESS',
      dexScreenerUrl: 'https://dexscreener.com/solana/NOVA_TOKEN_ADDRESS',
      dashboardUrl: 'http://localhost:5188/tokens/nova-token-id',
    },
    riskFlags: [],
  };
  return { ...base, ...overrides };
}

describe('renderAlert(SIGNAL)', () => {
  it('renders the exact NOVA-shaped alert text', () => {
    const text = renderAlert('SIGNAL', novaFixture());

    const expected = [
      '🚨 <b>FlowRadar Signal: HIGH</b>',
      '',
      'Token: $NOVA',
      'Chain: Solana',
      'Market Cap: $300.0k',
      'Liquidity: $25.0k',
      'FlowScore: 78.8/100',
      '',
      'Smart wallets buying: 42',
      'Estimated unique entities: 9',
      'Largest cluster: 18 wallets',
      'Cluster concentration: high',
      '',
      'Human-like wallets: 87%',
      'Tracked buy volume: $62.0k',
      'Tracked sell volume: $4.0k',
      'Net flow: $58.0k',
      'Avg smart entry mcap: $280.0k',
      'Current mcap: $300.0k',
      '',
      '<b>Why it triggered:</b>',
      '• 42 smart wallets bought within 25 minutes',
      '• Whale buy of $12,500 detected',
      '• 87% of buyers are human_like/smart_money',
      '',
      '<b>Links:</b>',
      '<a href="https://solscan.io/account/NOVA_TOKEN_ADDRESS">Explorer</a>',
      '<a href="https://dexscreener.com/solana/NOVA_TOKEN_ADDRESS">DexScreener</a>',
      '<a href="http://localhost:5188/tokens/nova-token-id">Dashboard</a>',
      '',
      '<b>Risk flags:</b>',
      'none recorded',
      '',
      FOOTER,
    ].join('\n');

    expect(text).toBe(expected);
  });

  it('contains the emoji header', () => {
    const text = renderAlert('SIGNAL', novaFixture());
    expect(text).toContain('🚨 <b>FlowRadar Signal: HIGH</b>');
  });

  it('contains the full entity-adjusted block (2026-07-05 wallet-driven scope correction)', () => {
    const text = renderAlert('SIGNAL', novaFixture());
    expect(text).toContain('Smart wallets buying: 42');
    expect(text).toContain('Estimated unique entities: 9');
    expect(text).toContain('Largest cluster: 18 wallets');
    expect(text).toContain('Cluster concentration: high');
  });

  it('ends with the exact footer line', () => {
    const text = renderAlert('SIGNAL', novaFixture());
    expect(text.endsWith(FOOTER)).toBe(true);
  });

  it('escapes a hostile symbol/reason so the output stays <b>-safe', () => {
    const text = renderAlert(
      'SIGNAL',
      novaFixture({ symbol: '<EVIL&>', reasons: ['reason with <script>alert(1)</script> & ampersand'] })
    );

    expect(text).toContain('Token: $&lt;EVIL&amp;&gt;');
    expect(text).toContain('• reason with &lt;script&gt;alert(1)&lt;/script&gt; &amp; ampersand');
    // No unescaped hostile tag leaks through anywhere in the rendered text.
    expect(text).not.toContain('<EVIL&>');
    expect(text).not.toContain('<script>');
  });

  it('renders "Why it triggered:" with a placeholder bullet when reasons is empty', () => {
    const text = renderAlert('SIGNAL', novaFixture({ reasons: [] }));
    expect(text).toContain('<b>Why it triggered:</b>\n• (no reasons recorded)');
  });

  it('omits the Explorer link when explorerUrl is null', () => {
    const text = renderAlert(
      'SIGNAL',
      novaFixture({ links: { explorerUrl: null, dexScreenerUrl: 'https://dexscreener.com/x', dashboardUrl: 'http://localhost:5188/tokens/x' } })
    );
    expect(text).not.toContain('>Explorer<');
    expect(text).toContain('>DexScreener<');
    expect(text).toContain('>Dashboard<');
  });

  it('renders top-3 risk flags with severity tags when present', () => {
    const text = renderAlert(
      'SIGNAL',
      novaFixture({
        riskFlags: [
          { label: 'Mint authority is still active', severity: 'danger' },
          { label: 'Top holder controls 60% of supply', severity: 'danger' },
          { label: 'Low liquidity', severity: 'warn' },
          { label: 'Fourth flag should be truncated', severity: 'info' },
        ],
      })
    );

    expect(text).toContain('<b>Risk flags:</b>\n• [danger] Mint authority is still active\n• [danger] Top holder controls 60% of supply\n• [warn] Low liquidity');
    expect(text).not.toContain('Fourth flag should be truncated');
    expect(text).not.toContain('none recorded');
  });

  it('renders "unknown" avg smart entry mcap when null (entity/mcap data not yet available)', () => {
    const text = renderAlert('SIGNAL', novaFixture({ avgSmartEntryMcapUsd: null }));
    expect(text).toContain('Avg smart entry mcap: unknown');
  });
});

// ---------------------------------------------------------------------------
// ROTATION
// ---------------------------------------------------------------------------

function rotationFixture(overrides: Partial<RotationAlertData> = {}): RotationAlertData {
  const base: RotationAlertData = {
    sourceTokenSymbol: 'ALPHA',
    destTokenSymbol: 'BETA',
    chainPath: ['SOLANA', 'BSC'],
    realizedProfitUsd: 3000,
    transferredValueUsd: 4800,
    timeGapMin: 35,
    destTokenMcapAtBuyUsd: 180_000,
    currentDestPerfPct: 42.5,
    confidence: 78,
    links: {
      explorerUrl: 'https://bscscan.com/address/BETA_DEST_WALLET',
      dexScreenerUrl: 'https://dexscreener.com/bsc/BETA_TOKEN_ADDRESS',
      dashboardUrl: 'http://localhost:5188/tokens/beta-token-id',
    },
  };
  return { ...base, ...overrides };
}

describe('renderAlert(ROTATION)', () => {
  it('renders the exact ALPHA->BETA-shaped rotation alert text', () => {
    const text = renderAlert('ROTATION', rotationFixture());

    const expected = [
      '🧠 <b>Profit Rotation Detected</b>',
      '',
      'From: $ALPHA',
      'To: $BETA',
      'Chain path: SOLANA → BSC',
      '',
      'Realized profit: $3.0k',
      'Transferred value: $4.8k',
      'Time gap: 35 min',
      '',
      'Destination mcap at buy: $180.0k',
      'Destination performance since: +42.5%',
      '',
      'Link confidence: 78/100 (probable rotation — on-chain evidence, not a confirmed same-owner claim)',
      '',
      '<b>Links:</b>',
      '<a href="https://bscscan.com/address/BETA_DEST_WALLET">Explorer</a>',
      '<a href="https://dexscreener.com/bsc/BETA_TOKEN_ADDRESS">DexScreener</a>',
      '<a href="http://localhost:5188/tokens/beta-token-id">Dashboard</a>',
      '',
      FOOTER,
    ].join('\n');

    expect(text).toBe(expected);
  });

  it('contains the emoji header', () => {
    expect(renderAlert('ROTATION', rotationFixture())).toContain('🧠 <b>Profit Rotation Detected</b>');
  });

  it('uses probabilistic language, never an unqualified "confirmed" claim', () => {
    const text = renderAlert('ROTATION', rotationFixture());
    expect(text).toContain('probable rotation');
    // The only "confirmed" mention must be the explicit negation ("not a
    // confirmed same-owner claim") — never an unqualified assertion of fact.
    expect(text.toLowerCase()).toContain('not a confirmed same-owner claim');
    expect(text.toLowerCase()).not.toContain('same person confirmed');
    expect(text.toLowerCase()).not.toMatch(/(?<!not a )confirmed same-owner/);
  });

  it('ends with the exact footer line', () => {
    expect(renderAlert('ROTATION', rotationFixture()).endsWith(FOOTER)).toBe(true);
  });

  it('escapes a hostile destination symbol', () => {
    const text = renderAlert('ROTATION', rotationFixture({ destTokenSymbol: '<EVIL&>' }));
    expect(text).toContain('To: $&lt;EVIL&amp;&gt;');
    expect(text).not.toContain('<EVIL&>');
  });

  it('renders "unknown" destination mcap when null', () => {
    const text = renderAlert('ROTATION', rotationFixture({ destTokenMcapAtBuyUsd: null }));
    expect(text).toContain('Destination mcap at buy: unknown');
  });
});

// ---------------------------------------------------------------------------
// WALLET_GRAPH
// ---------------------------------------------------------------------------

function walletGraphFixture(overrides: Partial<WalletGraphAlertData> = {}): WalletGraphAlertData {
  const base: WalletGraphAlertData = {
    rootAddress: 'FLOWDEEMOroot11111111111111111111111111111',
    chainName: 'Solana',
    mode: 'CAPITAL_FLOW',
    nodeCount: 6,
    edgeCount: 7,
    notableFindings: ['Root wallet touches 1 CEX-tagged node', 'Value chain A→B→C: $10,000 → $9,800 (98% retained)'],
    links: { dashboardUrl: 'http://localhost:5188/graph?searchId=abc123' },
  };
  return { ...base, ...overrides };
}

describe('renderAlert(WALLET_GRAPH)', () => {
  it('renders the exact wallet-graph alert text', () => {
    const text = renderAlert('WALLET_GRAPH', walletGraphFixture());

    const expected = [
      '🕸 <b>Wallet Graph Search Complete</b>',
      '',
      'Root address: <code>FLOWDEEMOroot11111111111111111111111111111</code>',
      'Chain: Solana',
      'Mode: CAPITAL_FLOW',
      '',
      'Nodes found: 6',
      'Edges found: 7',
      '',
      '<b>Notable findings:</b>',
      '• Root wallet touches 1 CEX-tagged node',
      '• Value chain A→B→C: $10,000 → $9,800 (98% retained)',
      '',
      '<b>Links:</b>',
      '<a href="http://localhost:5188/graph?searchId=abc123">Dashboard</a>',
      '',
      FOOTER,
    ].join('\n');

    expect(text).toBe(expected);
  });

  it('contains the emoji header', () => {
    expect(renderAlert('WALLET_GRAPH', walletGraphFixture())).toContain('🕸 <b>Wallet Graph Search Complete</b>');
  });

  it('ends with the exact footer line', () => {
    expect(renderAlert('WALLET_GRAPH', walletGraphFixture()).endsWith(FOOTER)).toBe(true);
  });

  it('renders a placeholder bullet when notableFindings is empty', () => {
    const text = renderAlert('WALLET_GRAPH', walletGraphFixture({ notableFindings: [] }));
    expect(text).toContain('<b>Notable findings:</b>\n• (none recorded)');
  });

  it('escapes a hostile root address', () => {
    const text = renderAlert('WALLET_GRAPH', walletGraphFixture({ rootAddress: '<EVIL&>' }));
    expect(text).toContain('Root address: <code>&lt;EVIL&amp;&gt;</code>');
    expect(text).not.toContain('<code><EVIL&></code>');
  });
});

// ---------------------------------------------------------------------------
// TEST
// ---------------------------------------------------------------------------

describe('renderAlert(TEST)', () => {
  const fixedTimestamp = new Date('2026-07-05T12:34:00.000Z');

  function testFixture(overrides: Partial<TestAlertData> = {}): TestAlertData {
    return { timestamp: fixedTimestamp, ...overrides };
  }

  it('renders the exact test-alert text (deterministic — no Date.now() used)', () => {
    const text = renderAlert('TEST', testFixture());

    const expected = [
      '🔔 <b>FlowRadar test alert</b>',
      '',
      'Sent: 2026-07-05 12:34 UTC',
      '',
      'This is a test — no signal fired. If you can read this, Telegram delivery is working.',
      '',
      FOOTER,
    ].join('\n');

    expect(text).toBe(expected);
  });

  it('contains a short "FlowRadar test alert" identifier', () => {
    expect(renderAlert('TEST', testFixture())).toContain('FlowRadar test alert');
  });

  it('contains the timestamp passed in (deterministic, not wall-clock)', () => {
    const other = new Date('2020-01-01T00:00:00.000Z');
    const text = renderAlert('TEST', testFixture({ timestamp: other }));
    expect(text).toContain('2020-01-01 00:00 UTC');
    expect(text).not.toContain('2026-07-05');
  });

  it('ends with the exact footer line', () => {
    expect(renderAlert('TEST', testFixture()).endsWith(FOOTER)).toBe(true);
  });
});
