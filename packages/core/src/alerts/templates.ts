// FlowRadar — Telegram alert templates (Task 16 binding decision 1).
//
// Normative source: Spec §9 "Alerts (Telegram first)" ("Three templates
// exactly per brief (Signal / Profit Rotation / Wallet Graph), plus TEST"),
// Spec §6 signal-rule table (entity-adjusted fields: rawWalletCount,
// uniqueEntityCount, largestClusterSize, entityConcentrationRisk — see
// Signal.metrics, populated by packages/db/src/signals.ts), and the Task 16
// task brief's binding decision 1 (exact field list/order per template, incl.
// the SIGNAL entity-adjusted block added by the 2026-07-05 wallet-driven
// scope correction). The ORIGINAL user-provided 17-module requirements brief
// (Spec line 6: "Source: user-provided 17-module requirements brief") is not
// checked into this repo as a standalone file — every task brief and the
// design spec itself only reference "Module 10" abstractly, with no literal
// template text quoted anywhere on disk (confirmed by search across
// .superpowers/sdd/*.md and docs/superpowers/**). This file is therefore the
// FIRST point where the literal template strings are authored, built to
// satisfy every field/section the spec + task-16 brief enumerate, in the
// order they're listed, using the emoji/footer/probabilistic-language
// conventions fixed elsewhere in this codebase (Spec §1 footer text; Rule
// severity vocabulary INFO/WATCH/HIGH/CRITICAL; RiskReport.flags severity
// vocabulary info/warn/danger — see packages/core/src/types.ts).
//
// packages/core is PURE (zero I/O, zero framework deps) — renderAlert takes
// every value it needs as plain data (AlertData) and a `now` timestamp passed
// in by the caller (no Date.now()/`new Date()` inside this file), so output
// is 100% deterministic and unit-testable byte-for-byte.
//
// Telegram HTML parse mode (see https://core.telegram.org/bots/api#html-style)
// supports a small tag subset (<b>, <i>, <code>, <a href="...">, ...) and
// treats bare "\n" as a line break — no <br> tag needed/supported. Every
// interpolated string value (symbol, chain name, reasons, risk flag labels,
// URLs) is HTML-escaped via escapeHtml() before interpolation so a token
// symbol containing '<'/'>'/'&' (e.g. a troll-named token '<EVIL&>') can
// never break Telegram's HTML parser or inject markup.

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * Escapes the 3 characters that matter to Telegram's HTML parse mode: '&'
 * MUST be escaped first (escaping '<'/'>' afterwards would double-escape the
 * '&' just introduced by their own escape sequences otherwise — order
 * matters here).
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ---------------------------------------------------------------------------
// Local formatters (packages/core has zero framework deps, so this does NOT
// import apps/web/lib/format.ts — the layering only flows core -> db/worker/
// web, never back. Bands mirror apps/web/lib/format.ts's fmtUsd for a
// visually consistent house style across the dashboard and Telegram alerts,
// re-implemented locally rather than shared to keep this package's "zero
// dependency on apps/web" contract intact.)
// ---------------------------------------------------------------------------

function fmtUsdLocal(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  const four = abs.toFixed(4);
  if (Number.parseFloat(four) > 0) return `${sign}$${four}`;
  return `${sign}$${abs.toFixed(6)}`;
}

function fmtPctLocal(n: number): string {
  if (!Number.isFinite(n)) return '+0.0%';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '+';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

function fmtIsoMinute(ts: Date): string {
  return ts.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ---------------------------------------------------------------------------
// Shared data shapes
// ---------------------------------------------------------------------------

/** Cluster-concentration label — degrades to 'unknown' until Task 22's clustering lands (mirrors Signal.metrics.entityConcentrationRisk, see packages/db/src/signals.ts). */
export type ClusterConcentration = 'low' | 'medium' | 'high' | 'unknown';

export interface AlertLinks {
  explorerUrl: string | null;
  dexScreenerUrl: string;
  dashboardUrl: string;
}

export interface AlertRiskFlag {
  label: string;
  severity: 'info' | 'warn' | 'danger';
}

/** SIGNAL template data (Spec §6/§9 + Task 16 binding decision 1 entity-adjusted block). */
export interface SignalAlertData {
  severity: 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';
  symbol: string;
  chainName: string;
  marketCapUsd: number;
  liquidityUsd: number;
  flowScore: number;
  /** Entity-adjusted block (2026-07-05 wallet-driven scope correction). */
  rawWalletCount: number;
  uniqueEntityCount: number;
  largestClusterSize: number;
  clusterConcentration: ClusterConcentration;
  humanLikePct: number;
  trackedBuyVolumeUsd: number;
  trackedSellVolumeUsd: number;
  netFlowUsd: number;
  avgSmartEntryMcapUsd: number | null;
  currentMcapUsd: number;
  reasons: string[];
  links: AlertLinks;
  /** Top risk flags (caller passes the already-truncated top-3 slice, or [] for "none recorded"). */
  riskFlags: AlertRiskFlag[];
}

/** ROTATION template data (Spec §6 Rule F / §9; consumed starting Wave 3's profitRotation job — ships now so the template + tests exist ahead of that consumer, per Task 16 binding decision 1). */
export interface RotationAlertData {
  sourceTokenSymbol: string;
  destTokenSymbol: string;
  chainPath: string[];
  realizedProfitUsd: number;
  transferredValueUsd: number;
  timeGapMin: number;
  destTokenMcapAtBuyUsd: number | null;
  currentDestPerfPct: number;
  confidence: number;
  links: AlertLinks;
}

/** WALLET_GRAPH template data (Spec §8.5 Wallet Graph Finder / §9). */
export interface WalletGraphAlertData {
  rootAddress: string;
  chainName: string;
  mode: 'DIRECT' | 'CAPITAL_FLOW' | 'ENTITY_DISCOVERY' | 'FULL_RAW';
  nodeCount: number;
  edgeCount: number;
  notableFindings: string[];
  links: Pick<AlertLinks, 'dashboardUrl'>;
}

/** TEST template data — Task 16 binding decision 6 (Send test alert / /api/alerts/test). */
export interface TestAlertData {
  timestamp: Date;
}

export type AlertData =
  | { kind: 'SIGNAL'; data: SignalAlertData }
  | { kind: 'ROTATION'; data: RotationAlertData }
  | { kind: 'WALLET_GRAPH'; data: WalletGraphAlertData }
  | { kind: 'TEST'; data: TestAlertData };

// ---------------------------------------------------------------------------
// Footer (Spec §1: "Alerts are informational, not financial advice (footer
// on alerts + dashboard)") — every template ends with this exact line.
// ---------------------------------------------------------------------------

const FOOTER = 'Analytics only — not financial advice.';

// ---------------------------------------------------------------------------
// SIGNAL (type 1)
// ---------------------------------------------------------------------------

function renderSignal(data: SignalAlertData): string {
  const lines: string[] = [];

  lines.push(`🚨 <b>FlowRadar Signal: ${escapeHtml(data.severity)}</b>`);
  lines.push('');
  lines.push(`Token: $${escapeHtml(data.symbol)}`);
  lines.push(`Chain: ${escapeHtml(data.chainName)}`);
  lines.push(`Market Cap: ${fmtUsdLocal(data.marketCapUsd)}`);
  lines.push(`Liquidity: ${fmtUsdLocal(data.liquidityUsd)}`);
  lines.push(`FlowScore: ${data.flowScore.toFixed(1)}/100`);
  lines.push('');
  lines.push(`Smart wallets buying: ${data.rawWalletCount}`);
  lines.push(`Estimated unique entities: ${data.uniqueEntityCount}`);
  lines.push(`Largest cluster: ${data.largestClusterSize} wallets`);
  lines.push(`Cluster concentration: ${escapeHtml(data.clusterConcentration)}`);
  lines.push('');
  lines.push(`Human-like wallets: ${data.humanLikePct.toFixed(0)}%`);
  lines.push(`Tracked buy volume: ${fmtUsdLocal(data.trackedBuyVolumeUsd)}`);
  lines.push(`Tracked sell volume: ${fmtUsdLocal(data.trackedSellVolumeUsd)}`);
  lines.push(`Net flow: ${fmtUsdLocal(data.netFlowUsd)}`);
  lines.push(`Avg smart entry mcap: ${data.avgSmartEntryMcapUsd !== null ? fmtUsdLocal(data.avgSmartEntryMcapUsd) : 'unknown'}`);
  lines.push(`Current mcap: ${fmtUsdLocal(data.currentMcapUsd)}`);
  lines.push('');
  lines.push('<b>Why it triggered:</b>');
  if (data.reasons.length === 0) {
    lines.push('• (no reasons recorded)');
  } else {
    for (const reason of data.reasons) {
      lines.push(`• ${escapeHtml(reason)}`);
    }
  }
  lines.push('');
  lines.push('<b>Links:</b>');
  if (data.links.explorerUrl) {
    lines.push(`<a href="${escapeHtml(data.links.explorerUrl)}">Explorer</a>`);
  }
  lines.push(`<a href="${escapeHtml(data.links.dexScreenerUrl)}">DexScreener</a>`);
  lines.push(`<a href="${escapeHtml(data.links.dashboardUrl)}">Dashboard</a>`);
  lines.push('');
  lines.push('<b>Risk flags:</b>');
  if (data.riskFlags.length === 0) {
    lines.push('none recorded');
  } else {
    for (const flag of data.riskFlags.slice(0, 3)) {
      lines.push(`• [${flag.severity}] ${escapeHtml(flag.label)}`);
    }
  }
  lines.push('');
  lines.push(FOOTER);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ROTATION (type 2)
// ---------------------------------------------------------------------------

function renderRotation(data: RotationAlertData): string {
  const lines: string[] = [];

  lines.push('🧠 <b>Profit Rotation Detected</b>');
  lines.push('');
  lines.push(`From: $${escapeHtml(data.sourceTokenSymbol)}`);
  lines.push(`To: $${escapeHtml(data.destTokenSymbol)}`);
  lines.push(`Chain path: ${data.chainPath.map((c) => escapeHtml(c)).join(' → ')}`);
  lines.push('');
  lines.push(`Realized profit: ${fmtUsdLocal(data.realizedProfitUsd)}`);
  lines.push(`Transferred value: ${fmtUsdLocal(data.transferredValueUsd)}`);
  lines.push(`Time gap: ${data.timeGapMin.toFixed(0)} min`);
  lines.push('');
  lines.push(`Destination mcap at buy: ${data.destTokenMcapAtBuyUsd !== null ? fmtUsdLocal(data.destTokenMcapAtBuyUsd) : 'unknown'}`);
  lines.push(`Destination performance since: ${fmtPctLocal(data.currentDestPerfPct)}`);
  lines.push('');
  lines.push(`Link confidence: ${data.confidence.toFixed(0)}/100 (probable rotation — on-chain evidence, not a confirmed same-owner claim)`);
  lines.push('');
  lines.push('<b>Links:</b>');
  if (data.links.explorerUrl) {
    lines.push(`<a href="${escapeHtml(data.links.explorerUrl)}">Explorer</a>`);
  }
  lines.push(`<a href="${escapeHtml(data.links.dexScreenerUrl)}">DexScreener</a>`);
  lines.push(`<a href="${escapeHtml(data.links.dashboardUrl)}">Dashboard</a>`);
  lines.push('');
  lines.push(FOOTER);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// WALLET_GRAPH (type 3)
// ---------------------------------------------------------------------------

function renderWalletGraph(data: WalletGraphAlertData): string {
  const lines: string[] = [];

  lines.push('🕸 <b>Wallet Graph Search Complete</b>');
  lines.push('');
  lines.push(`Root address: <code>${escapeHtml(data.rootAddress)}</code>`);
  lines.push(`Chain: ${escapeHtml(data.chainName)}`);
  lines.push(`Mode: ${escapeHtml(data.mode)}`);
  lines.push('');
  lines.push(`Nodes found: ${data.nodeCount}`);
  lines.push(`Edges found: ${data.edgeCount}`);
  lines.push('');
  lines.push('<b>Notable findings:</b>');
  if (data.notableFindings.length === 0) {
    lines.push('• (none recorded)');
  } else {
    for (const finding of data.notableFindings) {
      lines.push(`• ${escapeHtml(finding)}`);
    }
  }
  lines.push('');
  lines.push('<b>Links:</b>');
  lines.push(`<a href="${escapeHtml(data.links.dashboardUrl)}">Dashboard</a>`);
  lines.push('');
  lines.push(FOOTER);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// TEST (Task 16 binding decision 6)
// ---------------------------------------------------------------------------

function renderTest(data: TestAlertData): string {
  const lines: string[] = [];

  lines.push('🔔 <b>FlowRadar test alert</b>');
  lines.push('');
  lines.push(`Sent: ${fmtIsoMinute(data.timestamp)}`);
  lines.push('');
  lines.push('This is a test — no signal fired. If you can read this, Telegram delivery is working.');
  lines.push('');
  lines.push(FOOTER);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a Telegram HTML-parse-mode alert string for the given kind. Pure —
 * no I/O, no clock reads (every timestamp is carried on `data` by the
 * caller), so identical input always produces byte-identical output.
 */
export function renderAlert(kind: 'SIGNAL', data: SignalAlertData): string;
export function renderAlert(kind: 'ROTATION', data: RotationAlertData): string;
export function renderAlert(kind: 'WALLET_GRAPH', data: WalletGraphAlertData): string;
export function renderAlert(kind: 'TEST', data: TestAlertData): string;
export function renderAlert(
  kind: 'SIGNAL' | 'ROTATION' | 'WALLET_GRAPH' | 'TEST',
  data: SignalAlertData | RotationAlertData | WalletGraphAlertData | TestAlertData
): string {
  switch (kind) {
    case 'SIGNAL':
      return renderSignal(data as SignalAlertData);
    case 'ROTATION':
      return renderRotation(data as RotationAlertData);
    case 'WALLET_GRAPH':
      return renderWalletGraph(data as WalletGraphAlertData);
    case 'TEST':
      return renderTest(data as TestAlertData);
  }
}
