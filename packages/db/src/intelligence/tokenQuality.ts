import { createHash } from 'node:crypto';
import { parseSettings } from '@flowradar/core';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';

export const TOKEN_QUALITY_ENGINE_VERSION = 1;
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

  const [token, settingsRow, lpEvents, deployerEvent] = await Promise.all([
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
    })
  ]);
  const settings = parseSettings(settingsRow?.values ?? {});
  const market = token?.marketSnapshots[0] ?? null;
  const previousMarket = token?.marketSnapshots[1] ?? null;
  const risk = token?.riskSnapshot ?? null;
  const flags = parseFlags(risk?.flags ?? token?.riskFlags ?? []);
  const dangerFlags = flags.filter((flag) => flag.severity === 'danger');
  const ownershipFlags = flags.filter((flag) => /mint|freeze|owner|ownership|proxy|honeypot|cannot_sell|tax/i.test(flag.id));
  const holderFlags = flags.filter((flag) => /holder|concentration|whale|supply/i.test(flag.id));

  const liquidityUsd = decimal(market?.liquidityUsd);
  const marketCapUsd = decimal(market?.marketCapUsd);
  const holderCount = market?.holderCount ?? null;
  const marketFresh = Boolean(market && assessedAt.getTime() - market.ts.getTime() <= MAX_MARKET_AGE_MS);
  const riskFresh = Boolean(risk && risk.status === 'ok' && risk.observedAt && risk.expiresAt >= assessedAt);
  const liquidityPass = marketFresh && liquidityUsd !== null && liquidityUsd >= settings.rules.A.minLiquidityUsd;
  const marketCapPass = marketFresh && marketCapUsd !== null && marketCapUsd >= settings.rules.A.mcapMin && marketCapUsd <= settings.rules.A.mcapMax;
  const holderPass = riskFresh && holderCount !== null && holderCount >= MIN_HOLDERS && !holderFlags.some((flag) => flag.severity === 'danger');
  const ownershipPass = riskFresh && ownershipFlags.length === 0 && dangerFlags.length === 0;

  const latestLp = lpEvents[0] ?? null;
  const lpRemovedAfterAdd = latestLp?.kind === 'lp_remove';
  const lpPass = liquidityPass && !lpRemovedAfterAdd;
  const lpStatus = !marketFresh
    ? 'unavailable'
    : !liquidityPass
      ? 'insufficient_liquidity'
      : lpRemovedAfterAdd
        ? 'recent_lp_removal'
        : lpEvents.length
          ? 'lp_activity_verified'
          : 'market_liquidity_observed';

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

  let score = 0;
  if (liquidityPass) score += 15;
  if (holderPass) score += 15;
  if (deployerPass) score += deployerStrong ? 10 : 6;
  if (ownershipPass) score += 15;
  if (lpPass) score += 15;
  if (marketCapPass) score += 10;
  if (tradingPass) score += 15;
  if (riskFresh) score += 5;
  score = Math.round(score);

  const criticalChecks = [liquidityPass, holderPass, ownershipPass, lpPass, marketCapPass, tradingPass, riskFresh];
  const passed = criticalChecks.every(Boolean) && deployerPass && score >= 70;
  const knownChecks = [marketFresh, risk !== null, holderCount !== null, deployerAddress !== null, latestLp !== null, latestFlow !== null || latestStealth !== null].filter(Boolean).length;
  const coverage = knownChecks >= 5 ? 'full' : knownChecks >= 3 ? 'partial' : knownChecks >= 1 ? 'minimal' : 'unavailable';
  const reasonCodes = [
    marketFresh ? 'market_data_fresh' : 'market_data_missing_or_stale',
    liquidityPass ? 'liquidity_pass' : 'liquidity_fail',
    holderPass ? 'holder_distribution_pass' : 'holder_distribution_fail_or_unknown',
    deployerPass ? `deployer_${deployerQuality}` : 'deployer_quality_fail_or_unknown',
    ownershipPass ? 'ownership_pass' : 'ownership_fail_or_unknown',
    lpPass ? `lp_${lpStatus}` : `lp_fail_${lpStatus}`,
    marketCapPass ? 'market_cap_pass' : 'market_cap_fail',
    tradingPass ? 'trading_behavior_pass' : `trading_behavior_fail_${tradingBehavior}`,
    riskFresh ? 'risk_snapshot_fresh' : 'risk_snapshot_missing_stale_or_unavailable'
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
        results: { marketFresh, riskFresh, liquidityPass, holderPass, deployerPass, ownershipPass, lpPass, marketCapPass, tradingPass },
        dangerFlags,
        ownershipFlags,
        holderFlags,
        deployerAddress,
        deployerProfileId: deployerProfile?.id ?? null,
        lpEventIds: lpEvents.map((event) => event.eventId),
        latestFlowStatus: latestFlow?.signalStatus ?? null,
        latestStealthState: latestStealth?.state ?? null,
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
function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
