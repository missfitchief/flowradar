// FlowRadar — dispatchPendingAlerts: shared alert-dispatch pass body (Task 16
// binding decision 3).
//
// Shared by apps/worker/src/jobs/alertDispatch.ts (scheduled worker tick) and
// packages/db/src/seed.ts (one-shot seed pass), mirroring the exact
// worker/seed-sharing pattern already established by runFlowScoringPass
// (scoring-pass.ts) and runSignalDetectionPass (signals.ts) — see those
// files' headers for the pattern's origin (Task 6 brief: "do not copy-paste
// the logic twice").
//
// Per-Signal flow:
//   1. Find every Signal that has NO Alert row yet at all (any
//      deliveryStatus — `alerts: { none: {} }`), oldest triggeredAt first.
//   2. For each: look up the MOST RECENT Alert for this Signal's own
//      (tokenId, rule) pair — using the exact @@index([tokenId, rule,
//      sentAt]) the schema already carries for this purpose (Spec §4 Alert
//      model comment: "Index (tokenId, rule, sentAt) -> cooldown lookups").
//      That most-recent Alert's `sentAt` + the SEVERITY of the Signal it was
//      generated from (looked up via its own signalId, since Alert itself
//      doesn't carry severity) feed @flowradar/core's shouldSendAlert.
//   3. Cooldown says NO -> still create an Alert row, with deliveryStatus
//      'skipped_cooldown' (see the doc comment on SKIPPED_COOLDOWN below for
//      why this is a deliberate design choice, not an oversight).
//   4. Cooldown says YES -> assemble SignalAlertData from Signal + Token +
//      the latest TokenMarketSnapshot (liquidity) + latest TokenFlowSnapshot
//      (flowScore, humanLikeCount/smartWalletCount for humanLikePct) +
//      Token.riskFlags (top 3) + Chain (explorer URL template), render via
//      @flowradar/core's renderAlert, call `sender.send(text)`:
//        - send succeeds -> Alert row deliveryStatus 'sent'.
//        - sender is null (no token configured, e.g. MOCK/no-Telegram-env
//          mode) -> Alert row deliveryStatus 'skipped_no_token' (payload
//          still carries the fully-rendered text — "the text IS the
//          artifact" per Task 16 binding decision 5).
//        - send throws -> Alert row deliveryStatus 'failed' + `error` column
//          set from the caught error's message.
//
// Every Signal this pass ever looks at ends up with EXACTLY ONE Alert row by
// the time the pass finishes processing it (whichever status applies) — so a
// second dispatch pass over the same DB state finds zero pending Signals
// left (`alerts: { none: {} }` no longer matches any of them) and is a
// complete no-op. This is what Task 16's integration test asserts ("dispatch
// creates rows once, second run creates none").

import type { PrismaClient, Prisma } from '@prisma/client';
import { renderAlert, shouldSendAlert } from '@flowradar/core';
import type { Settings, SignalSeverity, AlertRiskFlag, ClusterConcentration } from '@flowradar/core';

const WEB_PORT_FALLBACK = 5188;

/**
 * Minimal outbound-send contract (Task 16 binding decision 3: "Sender
 * interface: { send(text: string): Promise<void> }"). `null` is a valid,
 * expected value for "no delivery channel configured" (e.g. MOCK mode /
 * missing TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID) — dispatchPendingAlerts
 * treats a null sender as "render the alert, but mark deliveryStatus
 * skipped_no_token instead of attempting a send" rather than throwing.
 */
export interface AlertSender {
  send(text: string): Promise<void>;
}

export interface AlertDispatchLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AlertDispatchResult {
  pendingConsidered: number;
  sent: number;
  skippedCooldown: number;
  skippedNoToken: number;
  failed: number;
  errors: number;
  /**
   * ROTATION-type Alert rows processed this pass (Task 23 binding decision
   * 4) — every ProfitRotationSignal without an Alert row yet gets exactly
   * one, mirroring the SIGNAL loop's own "alerts: none -> exactly one Alert"
   * invariant (see rotationPendingConsidered/rotationSent/etc. below, folded
   * into the SAME sent/skippedNoToken/failed/errors counters above so a
   * caller printing "N alerts sent" sees the true combined total — this
   * field additionally isolates the ROTATION subset for reporting).
   */
  rotationAlertsCreated: number;
}

/**
 * Runs one full alert-dispatch pass: every Signal without an Alert row yet
 * gets exactly one, per the file header's flow. `sender` is `null` in
 * MOCK/no-Telegram-env mode — every alert this pass creates then lands
 * `skipped_no_token` (the rendered `payload.text` is still the full,
 * real template output; only the actual network send is skipped).
 */
export async function dispatchPendingAlerts(
  prisma: PrismaClient,
  settings: Settings,
  sender: AlertSender | null,
  log?: AlertDispatchLogger
): Promise<AlertDispatchResult> {
  const now = new Date();

  const pendingSignals = await prisma.signal.findMany({
    where: { alerts: { none: {} } },
    orderBy: { triggeredAt: 'asc' },
    include: { token: true }
  });

  let sent = 0;
  let skippedCooldown = 0;
  let skippedNoToken = 0;
  let failed = 0;
  let errors = 0;

  for (const signal of pendingSignals) {
    try {
      const { token } = signal;
      if (!token) {
        // Defensive: Signal.tokenId is a required FK (never actually
        // nullable in practice — token is always included), but guard
        // against a deleted/orphaned row rather than crashing the pass.
        await prisma.alert.create({
          data: {
            signalId: signal.id,
            type: 'SIGNAL',
            channel: 'TELEGRAM',
            tokenId: signal.tokenId,
            rule: signal.rule,
            sentAt: now,
            payload: { text: '', dataUsed: {}, note: 'token missing' } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'skipped_no_token'
          }
        });
        skippedNoToken += 1;
        continue;
      }

      // Cooldown lookup: most recent Alert for this EXACT (tokenId, rule)
      // pair, using the @@index([tokenId, rule, sentAt]) the schema already
      // carries. Includes its originating Signal (via signalId) purely to
      // read that Signal's severity — Alert itself has no severity column.
      const lastAlertForRule = await prisma.alert.findFirst({
        where: { tokenId: token.id, rule: signal.rule },
        orderBy: { sentAt: 'desc' },
        include: { signal: { select: { severity: true } } }
      });

      const cooldownOk = shouldSendAlert({
        lastSentAt: lastAlertForRule?.sentAt ?? null,
        lastSeverity: (lastAlertForRule?.signal?.severity as SignalSeverity | undefined) ?? null,
        severityNow: signal.severity as SignalSeverity,
        now,
        cooldownMin: settings.alerts.cooldownMin
      });

      if (!cooldownOk) {
        // Cooldown-skipped signals STILL get an Alert row (deliveryStatus
        // 'skipped_cooldown') rather than being left pending — see the file
        // header: this is the deliberate design that makes
        // `alerts: { none: {} }` a correct "never re-evaluate this Signal
        // again" marker. The alternative (leaving no Alert row at all for a
        // cooldown-skipped signal) would make every future dispatch pass
        // re-check the SAME Signal's cooldown forever, which is harmless but
        // wasteful — worse, it would break the "one Alert row per Signal,
        // eventually" invariant this file's tests rely on (a signal that's
        // still within cooldown when this pass runs would otherwise NEVER
        // get an Alert row once the cooldown clears either, since nothing
        // re-triggers evaluation of an already-fired Signal — dispatch only
        // ever looks at NEW pending Signals, not old ones cycling back
        // through cooldown). Recording skipped_cooldown up front is
        // therefore correct: cooldown suppression is a property of "how the
        // token/rule pair was already alerted recently", decided once at the
        // moment this Signal is first seen, not a retryable state.
        await prisma.alert.create({
          data: {
            signalId: signal.id,
            type: 'SIGNAL',
            channel: 'TELEGRAM',
            tokenId: token.id,
            rule: signal.rule,
            sentAt: now,
            payload: {
              text: '',
              dataUsed: {},
              note: `cooldown active — last alert for (${token.id}, ${signal.rule}) sent ${lastAlertForRule?.sentAt.toISOString()}`
            } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'skipped_cooldown'
          }
        });
        skippedCooldown += 1;
        continue;
      }

      const { text, dataUsed } = await buildSignalAlertText(prisma, signal, token);

      if (sender === null) {
        await prisma.alert.create({
          data: {
            signalId: signal.id,
            type: 'SIGNAL',
            channel: 'TELEGRAM',
            tokenId: token.id,
            rule: signal.rule,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'skipped_no_token'
          }
        });
        skippedNoToken += 1;
        continue;
      }

      try {
        await sender.send(text);
        await prisma.alert.create({
          data: {
            signalId: signal.id,
            type: 'SIGNAL',
            channel: 'TELEGRAM',
            tokenId: token.id,
            rule: signal.rule,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'sent'
          }
        });
        sent += 1;
      } catch (sendErr) {
        const errorMessage = sendErr instanceof Error ? sendErr.message : String(sendErr);
        await prisma.alert.create({
          data: {
            signalId: signal.id,
            type: 'SIGNAL',
            channel: 'TELEGRAM',
            tokenId: token.id,
            rule: signal.rule,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'failed',
            error: errorMessage
          }
        });
        failed += 1;
        log?.error('alertDispatch: sender.send failed', { signalId: signal.id, tokenId: token.id, error: errorMessage });
      }
    } catch (err) {
      errors += 1;
      log?.error('alertDispatch: failed to process signal', {
        signalId: signal.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ---------------------------------------------------------------------
  // ROTATION alerts (Task 23 binding decision 4): every ProfitRotationSignal
  // without an Alert row yet gets exactly one — mirrors the SIGNAL loop's
  // own "alerts: none -> exactly one Alert" invariant above, but simpler:
  // ProfitRotationSignal has no severity/rule to cooldown against (its OWN
  // creation is already deduped on sourceWallet+destWallet+destToken within
  // 24h — see rotation.ts's header), so there is no cooldown check here,
  // only the render + send/skip/fail branching.
  // ---------------------------------------------------------------------
  let rotationAlertsCreated = 0;

  const pendingRotations = await prisma.profitRotationSignal.findMany({
    where: { alerts: { none: {} } },
    orderBy: { detectedAt: 'asc' },
    include: { sourceToken: true, destToken: true }
  });

  for (const rotation of pendingRotations) {
    try {
      const { sourceToken, destToken } = rotation;
      if (!sourceToken || !destToken) {
        // Defensive: both FKs are required (never actually nullable in
        // practice — both are included), but guard against a
        // deleted/orphaned row rather than crashing the pass.
        await prisma.alert.create({
          data: {
            rotationSignalId: rotation.id,
            type: 'ROTATION',
            channel: 'TELEGRAM',
            tokenId: destToken?.id ?? null,
            sentAt: now,
            payload: { text: '', dataUsed: {}, note: 'source/dest token missing' } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'skipped_no_token'
          }
        });
        skippedNoToken += 1;
        continue;
      }

      const { text, dataUsed } = await buildRotationAlertText(prisma, rotation, sourceToken, destToken);

      if (sender === null) {
        await prisma.alert.create({
          data: {
            rotationSignalId: rotation.id,
            type: 'ROTATION',
            channel: 'TELEGRAM',
            tokenId: destToken.id,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'skipped_no_token'
          }
        });
        skippedNoToken += 1;
        rotationAlertsCreated += 1;
        continue;
      }

      try {
        await sender.send(text);
        await prisma.alert.create({
          data: {
            rotationSignalId: rotation.id,
            type: 'ROTATION',
            channel: 'TELEGRAM',
            tokenId: destToken.id,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'sent'
          }
        });
        sent += 1;
        rotationAlertsCreated += 1;
      } catch (sendErr) {
        const errorMessage = sendErr instanceof Error ? sendErr.message : String(sendErr);
        await prisma.alert.create({
          data: {
            rotationSignalId: rotation.id,
            type: 'ROTATION',
            channel: 'TELEGRAM',
            tokenId: destToken.id,
            sentAt: now,
            payload: { text, dataUsed } as unknown as Prisma.InputJsonValue,
            deliveryStatus: 'failed',
            error: errorMessage
          }
        });
        failed += 1;
        rotationAlertsCreated += 1;
        log?.error('alertDispatch: sender.send failed (rotation)', {
          rotationSignalId: rotation.id,
          tokenId: destToken.id,
          error: errorMessage
        });
      }
    } catch (err) {
      errors += 1;
      log?.error('alertDispatch: failed to process rotation signal', {
        rotationSignalId: rotation.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: AlertDispatchResult = {
    pendingConsidered: pendingSignals.length + pendingRotations.length,
    sent,
    skippedCooldown,
    skippedNoToken,
    failed,
    errors,
    rotationAlertsCreated
  };
  log?.info('alertDispatch cycle complete', { ...summary });
  return summary;
}

// ---------------------------------------------------------------------------
// SignalAlertData assembly
// ---------------------------------------------------------------------------

type SignalWithToken = Prisma.SignalGetPayload<{ include: { token: true } }>['token'];

/** Reads the Chain row's explorerAddressUrl template and fills its {address} placeholder for `address` (mirrors apps/web/app/tokens/[id]/page.tsx's fillUrlTemplate). Returns null if the Chain row doesn't exist (defensive — every seeded/live deployment always has both Chain rows). */
async function buildExplorerUrl(prisma: PrismaClient, chain: 'SOLANA' | 'BSC', address: string): Promise<string | null> {
  const chainRow = await prisma.chain.findUnique({ where: { id: chain } });
  if (!chainRow) return null;
  return chainRow.explorerAddressUrl.replaceAll('{address}', address);
}

/** DexScreener's chain slug differs from our ChainId enum casing (same mapping apps/web/app/tokens/[id]/page.tsx uses). */
const DEXSCREENER_CHAIN_SLUG: Record<'SOLANA' | 'BSC', string> = {
  SOLANA: 'solana',
  BSC: 'bsc'
};

function buildDashboardUrl(tokenId: string): string {
  const port = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : WEB_PORT_FALLBACK;
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : WEB_PORT_FALLBACK;
  return `http://localhost:${resolvedPort}/tokens/${tokenId}`;
}

/** Reads Signal.metrics.entityConcentrationRisk (Task 15's degrade-to-'unknown' Json field) as a ClusterConcentration label. */
function readClusterConcentration(metrics: unknown): ClusterConcentration {
  if (metrics && typeof metrics === 'object' && 'entityConcentrationRisk' in metrics) {
    const value = (metrics as Record<string, unknown>).entityConcentrationRisk;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'unknown') {
      return value;
    }
    // Numeric entityConcentrationRisk (0..1, once Task 22's clustering job
    // populates a real value instead of the current 'unknown' placeholder —
    // see packages/db/src/signals.ts's own doc comment on this same field)
    // is bucketed into the same low/medium/high vocabulary the alert
    // template's Cluster concentration line expects.
    if (typeof value === 'number') {
      if (value >= 0.66) return 'high';
      if (value >= 0.33) return 'medium';
      return 'low';
    }
  }
  return 'unknown';
}

function readMetricNumber(metrics: unknown, key: string, fallback: number): number {
  if (metrics && typeof metrics === 'object' && key in metrics) {
    const value = (metrics as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  return fallback;
}

/**
 * Builds the rendered Telegram text + the raw dataUsed snapshot (persisted
 * verbatim on Alert.payload.dataUsed for later debugging/backtesting) for a
 * SIGNAL-type alert. Fetches the token's latest TokenMarketSnapshot (for
 * liquidity — Signal itself doesn't carry a liquidity column) and latest
 * TokenFlowSnapshot (for flowScore + humanLikeCount/smartWalletCount, mirrors
 * @flowradar/core's own humanRatio = humanLikeCount / max(smartWalletCount,1)
 * derivation in scoring/flowScore.ts) alongside the Signal row itself.
 */
async function buildSignalAlertText(
  prisma: PrismaClient,
  signal: Prisma.SignalGetPayload<{ include: { token: true } }>,
  token: NonNullable<SignalWithToken>
): Promise<{ text: string; dataUsed: Record<string, unknown> }> {
  const [latestMarket, latestFlow, chainRow] = await Promise.all([
    prisma.tokenMarketSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
    prisma.tokenFlowSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
    prisma.chain.findUnique({ where: { id: token.chain } })
  ]);

  const metrics = signal.metrics;
  // Prefer the CURRENT TokenFlowSnapshot's counts over Signal.metrics/Signal
  // columns: the signal-detection pass dedupes an already-active Signal row
  // within a 24h window (packages/db/src/signals.ts), so an OLDER Signal's
  // metrics JSON (and its walletCount/uniqueEntityCount columns, frozen at
  // detection time) can predate a later entity-clustering re-score and go
  // stale (e.g. a Signal's uniqueEntityCount freezes at the pre-clustering
  // raw count, 36, while TokenFlowSnapshot.uniqueEntityCount correctly
  // reflects the post-clustering figure, 19 — clustering doesn't re-fire the
  // rule so the Signal row is never replaced). This mirrors
  // apps/web/app/page.tsx's buildCard documented rationale verbatim — the
  // Telegram alert and the Signal Feed card must read the SAME live source
  // so the two surfaces never disagree. The flow snapshot is a fresh
  // per-token row every pass, so it never has this staleness problem;
  // Signal.metrics/Signal columns are used only as a fallback when no
  // TokenFlowSnapshot exists yet at all.
  const rawWalletCount = latestFlow ? latestFlow.smartWalletCount : readMetricNumber(metrics, 'rawWalletCount', signal.walletCount);
  const uniqueEntityCount = latestFlow ? latestFlow.uniqueEntityCount : readMetricNumber(metrics, 'uniqueEntityCount', signal.uniqueEntityCount);
  // largestClusterSize has no TokenFlowSnapshot equivalent column, so
  // Signal.metrics remains its only source (fallback-only in name alone).
  const largestClusterSize = readMetricNumber(metrics, 'largestClusterSize', 0);
  const clusterConcentration = readClusterConcentration(metrics);

  const smartWalletCount = latestFlow?.smartWalletCount ?? 0;
  const humanLikeCount = latestFlow?.humanLikeCount ?? 0;
  const humanLikePct = (humanLikeCount / Math.max(smartWalletCount, 1)) * 100;

  const marketCapUsd = Number(signal.mcapAtTrigger);
  const liquidityUsd = latestMarket ? Number(latestMarket.liquidityUsd) : 0;
  const flowScore = latestFlow?.flowScore ?? 0;
  const currentMcapUsd = latestFlow?.currentMcap ? Number(latestFlow.currentMcap) : marketCapUsd;
  const avgSmartEntryMcapUsd = latestFlow?.avgEntryMcap ? Number(latestFlow.avgEntryMcap) : null;
  const netFlowUsd = Number(signal.netFlowUsd);
  const trackedBuyVolumeUsd = latestFlow ? Number(latestFlow.trackedBuyVolumeUsd) : Math.max(netFlowUsd, 0);
  const trackedSellVolumeUsd = latestFlow ? Number(latestFlow.trackedSellVolumeUsd) : 0;

  const explorerUrl = chainRow ? chainRow.explorerAddressUrl.replaceAll('{address}', token.address) : null;
  const dexScreenerUrl = `https://dexscreener.com/${DEXSCREENER_CHAIN_SLUG[token.chain as 'SOLANA' | 'BSC']}/${token.address}`;
  const dashboardUrl = buildDashboardUrl(token.id);

  const riskFlagsRaw = Array.isArray(token.riskFlags) ? (token.riskFlags as unknown[]) : [];
  const riskFlags: AlertRiskFlag[] = riskFlagsRaw
    .filter((f): f is { label: string; severity: 'info' | 'warn' | 'danger' } => {
      return typeof f === 'object' && f !== null && 'label' in f && 'severity' in f;
    })
    .map((f) => ({ label: String(f.label), severity: f.severity }))
    .slice(0, 3);

  const reasons = Array.isArray(signal.reasons) ? (signal.reasons as unknown[]).map((r) => String(r)) : [];

  const text = renderAlert('SIGNAL', {
    severity: signal.severity as SignalSeverity,
    symbol: token.symbol,
    chainName: chainRow?.name ?? token.chain,
    marketCapUsd,
    liquidityUsd,
    flowScore,
    rawWalletCount,
    uniqueEntityCount,
    largestClusterSize,
    clusterConcentration,
    humanLikePct,
    trackedBuyVolumeUsd,
    trackedSellVolumeUsd,
    netFlowUsd,
    avgSmartEntryMcapUsd,
    currentMcapUsd,
    reasons,
    links: { explorerUrl, dexScreenerUrl, dashboardUrl },
    riskFlags
  });

  const dataUsed = {
    signalId: signal.id,
    tokenId: token.id,
    rule: signal.rule,
    severity: signal.severity,
    marketCapUsd,
    liquidityUsd,
    flowScore,
    rawWalletCount,
    uniqueEntityCount,
    largestClusterSize,
    clusterConcentration,
    humanLikePct,
    trackedBuyVolumeUsd,
    trackedSellVolumeUsd,
    netFlowUsd,
    avgSmartEntryMcapUsd,
    currentMcapUsd,
    reasons,
    riskFlagCount: riskFlags.length
  };

  return { text, dataUsed };
}

// ---------------------------------------------------------------------------
// RotationAlertData assembly (Task 23 binding decision 4)
// ---------------------------------------------------------------------------

type RotationWithTokens = Prisma.ProfitRotationSignalGetPayload<{ include: { sourceToken: true; destToken: true } }>;

/**
 * Builds the rendered Telegram text + the raw dataUsed snapshot for a
 * ROTATION-type alert, straight from a ProfitRotationSignal row's own
 * columns (unlike buildSignalAlertText, no separate TokenFlowSnapshot/
 * TokenMarketSnapshot lookup is needed — ProfitRotationSignal already
 * carries realizedProfitUsd/transferredValueUsd/chainPath/timeGapMin/
 * confidence/destTokenMcapAtBuy/currentDestPerfPct verbatim from the
 * matcher, per Task 23's RotationCandidate contract).
 */
async function buildRotationAlertText(
  prisma: PrismaClient,
  rotation: RotationWithTokens,
  sourceToken: RotationWithTokens['sourceToken'],
  destToken: RotationWithTokens['destToken']
): Promise<{ text: string; dataUsed: Record<string, unknown> }> {
  const [chainRow] = await Promise.all([prisma.chain.findUnique({ where: { id: destToken.chain } })]);

  const realizedProfitUsd = Number(rotation.realizedProfitUsd);
  const transferredValueUsd = Number(rotation.transferredValueUsd);
  const destTokenMcapAtBuyUsd = Number(rotation.destTokenMcapAtBuy);

  const explorerUrl = chainRow ? chainRow.explorerAddressUrl.replaceAll('{address}', destToken.address) : null;
  const dexScreenerUrl = `https://dexscreener.com/${DEXSCREENER_CHAIN_SLUG[destToken.chain as 'SOLANA' | 'BSC']}/${destToken.address}`;
  const dashboardUrl = buildDashboardUrl(destToken.id);

  const text = renderAlert('ROTATION', {
    sourceTokenSymbol: sourceToken.symbol,
    destTokenSymbol: destToken.symbol,
    chainPath: rotation.chainPath,
    realizedProfitUsd,
    transferredValueUsd,
    timeGapMin: rotation.timeGapMin,
    destTokenMcapAtBuyUsd,
    currentDestPerfPct: rotation.currentDestPerfPct,
    confidence: rotation.confidence,
    links: { explorerUrl, dexScreenerUrl, dashboardUrl }
  });

  const dataUsed = {
    rotationSignalId: rotation.id,
    sourceWalletId: rotation.sourceWalletId,
    destWalletId: rotation.destWalletId,
    sourceTokenId: sourceToken.id,
    destTokenId: destToken.id,
    realizedProfitUsd,
    transferredValueUsd,
    chainPath: rotation.chainPath,
    timeGapMin: rotation.timeGapMin,
    confidence: rotation.confidence,
    destTokenMcapAtBuyUsd,
    currentDestPerfPct: rotation.currentDestPerfPct
  };

  return { text, dataUsed };
}

// Exported for the /api/alerts/test route + apps/worker's alertDispatch job,
// which both need to build a lone TEST-kind alert without going through the
// full pending-Signal dispatch loop above.
export { buildExplorerUrl, buildDashboardUrl, DEXSCREENER_CHAIN_SLUG };
