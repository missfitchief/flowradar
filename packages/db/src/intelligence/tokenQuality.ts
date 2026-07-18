import { createHash } from 'node:crypto';
import { parseSettings } from '@flowradar/core';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';

export const TOKEN_QUALITY_ENGINE_VERSION = 2;
const MIN_HOLDERS = 50;
const MIN_DAILY_VOLUME_USD = 1_000;
const MAX_MARKET_AGE_MS = 24 * 60 * 60_000;

export interface TokenQualityInput {
  chain: ChainId;
  tokenAddress: string;
  sourceEventIds: string[];
  assessedAt?: Date;
}

/**
 * Applies the existing market/risk data as a hard second gate after wallet
 * intelligence. Missing data is explicit and cannot silently become "safe".
 */
export async function assessTokenQuality(prisma: PrismaClient, input: TokenQualityInput) {
  const assessedAt = input.assessedAt ?? new Date();
  const sourceEventIds = [...new Set(input.sourceEventIds)].sort();
  const assessmentKey = hash(`token-quality|${input.chain}|${input.tokenAddress}|${sourceEventIds.join(',')}|v${TOKEN_QUALITY_ENGINE_VERSION}`);
  const existing = await prisma.tokenQualityAssessment.findUnique({ where: { assessmentKey } });
  if (existing) return existing;

  const [token, settingsRow, lpEvents, deployerEvent, sourceEvents] = await Promise.all([
    prisma.token.findUnique({
      where: { chain_address: { chain: input.chain, address: input.tokenAddress } },
      include: {
        marketSnapshots: { where: { ts: { lte: assessedAt } }, orderBy: { ts: 'desc' }, take: 2 },
        flowSnapshots: { where: { ts: { lte: assessedAt } }, orderBy: { ts: 'desc' }, take: 1 },
        stealthSnapshots: { where: { computedAt: { lte: assessedAt } }, orderBy: { computedAt: 'desc' }, take: 1 },
        riskSnapshot: true
      }
    }),
    prisma.settings.findFirst(),
    prisma.massTransactionEvent.findMany({
      where: { chain: input.chain, assetAddress: input.tokenAddress, kind: { in: ['lp_add', 'lp_remove'] }, ts: { lte: assessedAt }, status: { not: 'failed' } },
      orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], take: 100
    }),
    prisma.massTransactionEvent.findFirst({
      where: {
        chain: input.chain,
        kind: 'contract_interaction',
        ts: { lte: assessedAt },
        OR: [{ assetAddress: input.tokenAddress }, { programOrContract: input.tokenAddress }, { toAddress: input.tokenAddress }]
      },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }]
    }),
    sourceEventIds.length ? prisma.massTransactionEvent.findMany({ where: { eventId: { in: sourceEventIds }, ts: { lte: assessedAt } } }) : Promise.resolve([])
  ]);
  const settings = parseSettings(settingsRow?.values ?? {});
  const market = token?.marketSnapshots[0] ?? null;
  const previousMarket = token?.marketSnapshots[1] ?? null;
  const risk = token?.riskSnapshot ?? null;
  const flags = parseFlags(risk?.flags ?? token?.riskFlags ?? []);
  const dangerFlags = flags.filter((flag) => flag.severity === 'danger');
  const ownershipFlags = flags.filter((flag) => /mint|freeze|owner|ownership|proxy|honeypot|cannot_sell|tax/i.test(flag.id));
  const holderFlags = flags.filter((flag) => /holder|concentration|whale|supply/i.test(flag.id));
  const bundleFlags = flags.filter((flag) => /bundle|sniper|same.?block|linked.?holder/i.test(flag.id));
  const sellabilityFlags = flags.filter((flag) => /honeypot|cannot.?sell|sell.?tax|transfer.?tax/i.test(flag.id));
  const transferControlFlags = flags.filter((flag) => /blacklist|whitelist|pause|transfer.?control|freeze/i.test(flag.id));
  const lpSecurityFlags = flags.filter((flag) => /lp.?lock|liquidity.?lock|lp.?burn|burned.?lp/i.test(flag.id));

  const liquidityUsd = decimal(market?.liquidityUsd);
  const marketCapUsd = decimal(market?.marketCapUsd);
  const holderCount = market?.holderCount ?? null;
  const marketFresh = Boolean(market && assessedAt.getTime() - market.ts.getTime() <= MAX_MARKET_AGE_MS);
  const riskFresh = Boolean(risk && risk.status === 'ok' && risk.observedAt && risk.observedAt <= assessedAt && risk.expiresAt >= assessedAt);
  const liquidityPass = marketFresh && liquidityUsd !== null && liquidityUsd >= settings.rules.A.minLiquidityUsd;
  const marketCapPass = marketFresh && marketCapUsd !== null && marketCapUsd >= settings.rules.A.mcapMin && marketCapUsd <= settings.rules.A.mcapMax;
  const holderPass = riskFresh && holderCount !== null && holderCount >= MIN_HOLDERS && !holderFlags.some((flag) => flag.severity === 'danger');
  const ownershipPass = riskFresh && ownershipFlags.length === 0 && dangerFlags.length === 0;

  const latestLp = lpEvents[0] ?? null;
  const lpRemovedAfterAdd = latestLp?.kind === 'lp_remove';
  const lpLockOrBurnObserved = lpSecurityFlags.some((flag) => flag.severity !== 'danger')
    || lpEvents.some((event) => jsonHasMarker(event.metadataJson, /locked|burned|dead.?address|permanent/i));
  const lpSecurityPass = lpLockOrBurnObserved && !lpRemovedAfterAdd;
  const lpPass = liquidityPass && lpSecurityPass;
  const lpStatus = !marketFresh
    ? 'unavailable'
    : !liquidityPass
      ? 'insufficient_liquidity'
      : lpRemovedAfterAdd
        ? 'recent_lp_removal'
        : lpLockOrBurnObserved
          ? 'lp_lock_or_burn_verified'
          : 'lp_lock_or_burn_unknown';

  const deployerAddress = deployerEvent?.actorAddress ?? deployerEvent?.fromAddress ?? null;
  const deployerProfile = deployerAddress
    ? await prisma.walletIntelligenceProfile.findUnique({ where: { chain_address: { chain: input.chain, address: deployerAddress } } })
    : null;
  const deployerStrong = Boolean(deployerProfile && deployerProfile.historicalAlphaScore >= 45 && deployerProfile.confidence >= 0.55);
  const deployerNegative = ownershipFlags.length > 0 || dangerFlags.some((flag) => /honeypot|tax|cannot_sell/i.test(flag.id));
  const deployerQuality = deployerNegative
    ? 'negative'
    : deployerStrong
      ? 'historically_qualified'
      : deployerAddress
        ? 'observed_no_negative_evidence'
        : riskFresh
          ? 'ownership_clean_deployer_unknown'
          : 'unavailable';
  const deployerPass = !deployerNegative && deployerQuality !== 'unavailable';

  const latestFlow = token?.flowSnapshots[0] ?? null;
  const latestStealth = token?.stealthSnapshots[0] ?? null;
  const behaviorBlocked = latestFlow?.signalStatus === 'dead' || latestFlow?.signalStatus === 'exit_warning'
    || latestStealth?.state === 'DISTRIBUTION_RISK' || latestStealth?.state === 'INVALIDATED';
  const volume24h = decimal(market?.vol24h);
  const liquidityCollapsing = liquidityUsd !== null && previousMarket
    ? liquidityUsd < decimal(previousMarket.liquidityUsd)! * (1 - settings.rules.G.liquidityDropPct / 100)
    : false;
  const tradingPass = marketFresh && volume24h !== null && volume24h >= MIN_DAILY_VOLUME_USD && !behaviorBlocked && !liquidityCollapsing;
  const tradingBehavior = !marketFresh || volume24h === null
    ? 'unavailable'
    : behaviorBlocked
      ? 'distribution_or_exit_risk'
      : liquidityCollapsing
        ? 'liquidity_collapse'
        : volume24h < MIN_DAILY_VOLUME_USD
          ? 'insufficient_observed_volume'
          : 'active_no_distribution_risk';

  const bundleConcentrationPass = riskFresh && bundleFlags.every((flag) => flag.severity !== 'danger');
  const sellabilityPass = riskFresh && sellabilityFlags.length === 0;
  const transferControlsPass = riskFresh && transferControlFlags.length === 0;
  const sourceNotionalUsd = sourceEvents.reduce((sum, event) => sum + (decimal(event.amountUsd) ?? 0), 0);
  const estimatedSlippagePct = liquidityUsd !== null && liquidityUsd > 0 && sourceNotionalUsd > 0
    ? Math.min(100, sourceNotionalUsd / liquidityUsd * 100)
    : null;
  const slippagePass = estimatedSlippagePct !== null && estimatedSlippagePct <= 5;
  const routePass = Boolean(token?.pairAddress && token?.dex) && !flags.some((flag) => flag.severity === 'danger' && /route|proxy|delegate.?call|unverified.?contract/i.test(flag.id));
  const tokenAgeMinutes = token?.tokenCreatedAt ? Math.max(0, (assessedAt.getTime() - token.tokenCreatedAt.getTime()) / 60_000) : null;
  const freshMicrocapRisk = tokenAgeMinutes !== null && tokenAgeMinutes < 60 && marketCapUsd !== null && marketCapUsd < Math.max(settings.rules.A.mcapMin * 2, 100_000);

  let score = 0;
  if (liquidityPass) score += 10;
  if (holderPass) score += 10;
  if (deployerPass) score += deployerStrong ? 8 : 5;
  if (ownershipPass) score += 10;
  if (lpPass) score += 12;
  if (marketCapPass && !freshMicrocapRisk) score += 8;
  if (tradingPass) score += 10;
  if (riskFresh) score += 5;
  if (bundleConcentrationPass) score += 8;
  if (sellabilityPass) score += 8;
  if (transferControlsPass) score += 5;
  if (slippagePass) score += 3;
  if (routePass) score += 3;
  score = Math.round(score);

  const criticalChecks = [
    liquidityPass, holderPass, ownershipPass, lpPass, marketCapPass, tradingPass, riskFresh,
    bundleConcentrationPass, sellabilityPass, transferControlsPass, slippagePass, routePass, !freshMicrocapRisk
  ];
  const passed = criticalChecks.every(Boolean) && deployerPass && score >= 78;
  const knownChecks = [
    marketFresh, risk !== null, holderCount !== null, deployerAddress !== null, lpLockOrBurnObserved,
    latestFlow !== null || latestStealth !== null, estimatedSlippagePct !== null, token?.pairAddress && token?.dex
  ].filter(Boolean).length;
  const coverage = knownChecks >= 7 ? 'full' : knownChecks >= 4 ? 'partial' : knownChecks >= 1 ? 'minimal' : 'unavailable';
  const reasonCodes = [
    marketFresh ? 'market_data_fresh' : 'market_data_missing_or_stale',
    liquidityPass ? 'liquidity_pass' : 'liquidity_fail',
    holderPass ? 'holder_distribution_pass' : 'holder_distribution_fail_or_unknown',
    deployerPass ? `deployer_${deployerQuality}` : 'deployer_quality_fail_or_unknown',
    ownershipPass ? 'ownership_pass' : 'ownership_fail_or_unknown',
    lpPass ? `lp_${lpStatus}` : `lp_fail_${lpStatus}`,
    marketCapPass ? 'market_cap_pass' : 'market_cap_fail',
    tradingPass ? 'trading_behavior_pass' : `trading_behavior_fail_${tradingBehavior}`,
    riskFresh ? 'risk_snapshot_fresh' : 'risk_snapshot_missing_stale_or_unavailable',
    bundleConcentrationPass ? 'bundle_concentration_pass' : 'bundle_concentration_fail_or_unknown',
    sellabilityPass ? 'sellability_pass' : 'sellability_fail_or_unknown',
    transferControlsPass ? 'transfer_controls_pass' : 'transfer_controls_fail_or_unknown',
    slippagePass ? 'slippage_pass' : 'slippage_fail_or_unknown',
    routePass ? 'route_chain_pass' : 'route_chain_fail_or_unknown',
    freshMicrocapRisk ? 'fresh_microcap_risk' : 'fresh_microcap_check_pass'
  ];

  return prisma.tokenQualityAssessment.create({
    data: {
      assessmentKey,
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      passed,
      score,
      coverage,
      liquidityUsd,
      marketCapUsd,
      holderCount,
      riskPenalty: risk?.penalty ?? null,
      holderDistribution: holderPass ? 'acceptable' : holderCount === null || !riskFresh ? 'unknown' : 'risky',
      deployerQuality,
      ownershipStatus: ownershipPass ? 'ownership_controls_clear' : riskFresh ? 'ownership_risk_detected' : 'unknown',
      lpStatus,
      tradingBehavior,
      checksJson: json({
        thresholds: {
          minLiquidityUsd: settings.rules.A.minLiquidityUsd,
          marketCapMinUsd: settings.rules.A.mcapMin,
          marketCapMaxUsd: settings.rules.A.mcapMax,
          minHolders: MIN_HOLDERS,
          minDailyVolumeUsd: MIN_DAILY_VOLUME_USD,
          maxMarketAgeMs: MAX_MARKET_AGE_MS
        },
        results: {
          marketFresh, riskFresh, liquidityPass, holderPass, deployerPass, ownershipPass,
          lpPass, lpSecurityPass, marketCapPass, tradingPass, bundleConcentrationPass,
          sellabilityPass, transferControlsPass, slippagePass, routePass, freshMicrocapRisk
        },
        dangerFlags,
        ownershipFlags,
        holderFlags,
        bundleFlags,
        sellabilityFlags,
        transferControlFlags,
        lpSecurityFlags,
        deployerAddress,
        deployerProfileId: deployerProfile?.id ?? null,
        lpEventIds: lpEvents.map((event) => event.eventId),
        latestFlowStatus: latestFlow?.signalStatus ?? null,
        latestStealthState: latestStealth?.state ?? null,
        sourceNotionalUsd,
        estimatedSlippagePct,
        tokenAgeMinutes,
        pairAddress: token?.pairAddress ?? null,
        dex: token?.dex ?? null,
        sourceEventIds,
        engineVersion: TOKEN_QUALITY_ENGINE_VERSION
      }),
      reasonCodes,
      assessedAt
    }
  });
}

function parseFlags(value: Prisma.JsonValue): Array<{ id: string; label: string; severity: 'info' | 'warn' | 'danger' }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string') return [];
    const severity = row.severity === 'danger' || row.severity === 'warn' ? row.severity : 'info';
    return [{ id: row.id, label: typeof row.label === 'string' ? row.label : row.id, severity }];
  });
}
function jsonHasMarker(value: Prisma.JsonValue, pattern: RegExp) { try { return pattern.test(JSON.stringify(value)); } catch { return false; } }
function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
