import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PriceChart } from '@/components/tokens/PriceChart';
import type { PricePoint, TradeMarker } from '@/components/tokens/PriceChart';
import { NetFlowChart } from '@/components/tokens/NetFlowChart';
import type { NetFlowPoint } from '@/components/tokens/NetFlowChart';
import { TradesTimeline } from '@/components/tokens/TradesTimeline';
import type { TimelineTrade } from '@/components/tokens/TradesTimeline';
import { WalletBuyersTable } from '@/components/tokens/WalletBuyersTable';
import type { BuyerWalletLabel, BuyerWalletRow } from '@/components/tokens/WalletBuyersTable';
import { RiskPanel } from '@/components/tokens/RiskPanel';
import type { RiskFlagRow } from '@/components/tokens/RiskPanel';
import { getTokenSocialMentions, getTokenConfluence } from '@flowradar/db';
import { computeMentionVelocity, DEFAULT_SETTINGS } from '@flowradar/core';
import { SocialSection } from '@/components/tokens/SocialSection';
import type { SocialMentionRowVM } from '@/components/tokens/SocialSection';
import { ConfluencePanel } from '@/components/tokens/ConfluencePanel';
import { fmtAge, fmtUsd } from '@/lib/format';

// DB-backed detail page — must render per-request, never freeze at build time
// (matches every other DB-backed route: /tokens, /flow, /graph, /wallets, …).
export const dynamic = 'force-dynamic';

interface TokenDetailPageProps {
  params: Promise<{ id: string }>;
}

const CHAIN_BADGE_CLASS: Record<'SOLANA' | 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'BSC', string> = {
  SOLANA: 'border-transparent bg-violet-500/15 text-violet-300',
  ETHEREUM: 'border-transparent bg-blue-500/15 text-blue-300',
  BASE: 'border-transparent bg-sky-500/15 text-sky-300',
  ARBITRUM: 'border-transparent bg-cyan-500/15 text-cyan-300',
  BSC: 'border-transparent bg-amber-500/15 text-amber-300',
};

const SIGNAL_BADGE_CLASS: Record<string, string> = {
  watching: 'border-transparent bg-zinc-500/15 text-zinc-300',
  hot: 'border-transparent bg-orange-500/15 text-orange-300',
  profit_rotation: 'border-transparent bg-violet-500/15 text-violet-300',
  exit_warning: 'border-transparent bg-red-500/15 text-red-400',
  dead: 'border-transparent bg-zinc-800/50 text-zinc-500',
};

/** DexScreener's chain slug differs from our ChainId enum casing (binding decision #8). */
const DEXSCREENER_CHAIN_SLUG: Record<'SOLANA' | 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'BSC', string> = {
  SOLANA: 'solana',
  ETHEREUM: 'ethereum',
  BASE: 'base',
  ARBITRUM: 'arbitrum',
  BSC: 'bsc',
};

/** Fills a Chain registry URL template's {hash}/{address} placeholder. */
function fillUrlTemplate(template: string, values: { hash?: string; address?: string }): string {
  let out = template;
  if (values.hash !== undefined) out = out.replaceAll('{hash}', values.hash);
  if (values.address !== undefined) out = out.replaceAll('{address}', values.address);
  return out;
}

/**
 * Token Detail page (Task 9). Real data — replaces the Task-7 shell.
 *
 * Query shape: fetch the Token row first (404 via notFound() on miss), then
 * fan out in parallel for everything else this page needs — Chain registry
 * row (explorer URL template), latest market + flow snapshots (header stats),
 * the full 72h TokenMarketSnapshot series (PriceChart), the full
 * TokenFlowSnapshot history (NetFlowChart), and every WalletTokenTrade for
 * this token (TradesTimeline + WalletBuyersTable both derive from the same
 * trade set, so it's fetched once with wallet + classifications + stats
 * eager-loaded rather than twice).
 *
 * Every Prisma Decimal is converted via Number(...) and every Date crossing
 * into a 'use client' chart component is converted to an ISO string, right
 * here at the query boundary (binding decision #9) — the chart components
 * never see a Decimal or a Date.
 */
export default async function TokenDetailPage({ params }: TokenDetailPageProps) {
  const { id } = await params;
  const token = await prisma.token.findUnique({ where: { id } });

  if (!token) notFound();

  const [chain, latestMarket, latestFlow, marketSeries, flowHistory, trades, socialMentions, confluence] =
    await Promise.all([
      prisma.chain.findUnique({ where: { id: token.chain } }),
      prisma.tokenMarketSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
      prisma.tokenFlowSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
      prisma.tokenMarketSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { ts: 'asc' } }),
      prisma.tokenFlowSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { ts: 'asc' } }),
      prisma.walletTokenTrade.findMany({
        where: { tokenId: token.id, action: { in: ['BUY', 'SELL'] } },
        orderBy: { ts: 'asc' },
        include: {
          wallet: {
            include: {
              classifications: true,
              stats: { orderBy: { computedAt: 'desc' }, take: 1 },
            },
          },
        },
      }),
      getTokenSocialMentions(prisma, token.id),
      getTokenConfluence(prisma, token.id),
    ]);

  // ---------------------------------------------------------------------
  // Header block
  // ---------------------------------------------------------------------
  const ageLabel = `${fmtAge(token.firstSeenAt)} old`;
  const explorerAddressUrl = chain
    ? fillUrlTemplate(chain.explorerAddressUrl, { address: token.address })
    : null;
  const dexScreenerUrl = `https://dexscreener.com/${DEXSCREENER_CHAIN_SLUG[token.chain]}/${token.address}`;

  // ---------------------------------------------------------------------
  // PriceChart props
  // ---------------------------------------------------------------------
  const pricePoints: PricePoint[] = marketSeries.map((s) => ({
    ts: s.ts.toISOString(),
    priceUsd: Number(s.priceUsd),
    marketCapUsd: Number(s.marketCapUsd),
  }));
  const tradeMarkers: TradeMarker[] = trades.map((t) => ({
    ts: t.ts.toISOString(),
    priceUsd: Number(t.priceUsd),
    action: t.action as 'BUY' | 'SELL',
  }));

  // ---------------------------------------------------------------------
  // NetFlowChart props
  // ---------------------------------------------------------------------
  const netFlowPoints: NetFlowPoint[] = flowHistory.map((s) => ({
    ts: s.ts.toISOString(),
    netFlowUsd: Number(s.netFlowUsd),
  }));

  // ---------------------------------------------------------------------
  // TradesTimeline props
  // ---------------------------------------------------------------------
  const timelineTrades: TimelineTrade[] = trades.map((t) => ({
    id: t.id,
    ts: t.ts,
    action: t.action as 'BUY' | 'SELL',
    walletAddress: t.wallet.address,
    amountUsd: Number(t.amountUsd),
    priceUsd: Number(t.priceUsd),
    marketCapAtTrade: Number(t.marketCapAtTrade),
  }));

  // ---------------------------------------------------------------------
  // WalletBuyersTable props — distinct buyer wallets with per-token
  // buy/sell USD totals, aggregated in-memory from the same trade set
  // TradesTimeline uses (one query, two views).
  // ---------------------------------------------------------------------
  interface WalletAgg {
    walletId: string;
    address: string;
    labels: BuyerWalletLabel[];
    walletScore: number | null;
    buyUsd: number;
    sellUsd: number;
  }
  const walletAggById = new Map<string, WalletAgg>();
  for (const trade of trades) {
    let agg = walletAggById.get(trade.walletId);
    if (!agg) {
      agg = {
        walletId: trade.walletId,
        address: trade.wallet.address,
        labels: trade.wallet.classifications.map((c) => c.label as BuyerWalletLabel),
        walletScore: trade.wallet.stats[0]?.walletScore ?? null,
        buyUsd: 0,
        sellUsd: 0,
      };
      walletAggById.set(trade.walletId, agg);
    }
    const usd = Number(trade.amountUsd);
    if (trade.action === 'BUY') agg.buyUsd += usd;
    else agg.sellUsd += usd;
  }
  // Only wallets that have actually bought this token are "buyers" (binding
  // decision #6: "distinct buyer wallets") — a wallet appearing solely via a
  // SELL row (no BUY for this token in the fetched set) is excluded.
  const buyerRows: BuyerWalletRow[] = [...walletAggById.values()].filter((w) => w.buyUsd > 0);

  // ---------------------------------------------------------------------
  // RiskPanel props
  // ---------------------------------------------------------------------
  const riskFlags: RiskFlagRow[] = Array.isArray(token.riskFlags) ? (token.riskFlags as unknown as RiskFlagRow[]) : [];

  // ---------------------------------------------------------------------
  // SocialSection props (Task F) — shadow-only. Velocity is computed on read
  // from THIS token's mentions (spam excluded above spamMaxScore), never
  // stored. Spam is filtered for display in the component, not dropped here.
  // ---------------------------------------------------------------------
  const socialCfg = DEFAULT_SETTINGS.connectors.social;
  const mentionVelocity = computeMentionVelocity(
    socialMentions.map((m) => ({
      tokenId: m.tokenId,
      tokenAddress: m.tokenAddress,
      authorHash: m.authorHash,
      postedAt: m.postedAt,
      spamScore: m.spamScore,
    })),
    new Date(),
    // spamMaxScore = uiHideThreshold - 1 so velocity keeps EXACTLY the mentions
    // the feed shows (feed greys spamScore >= uiHideThreshold) — same cutoff as
    // /social page.tsx, avoiding an off-by-one where a mention scored exactly at
    // the threshold is greyed in the feed yet counted in velocity.
    { windowsMin: socialCfg.velocityWindowsMin, spamMaxScore: socialCfg.spam.uiHideThreshold - 1 },
  );
  const socialMentionRows: SocialMentionRowVM[] = socialMentions.map((m) => ({
    id: m.id,
    sourceName: m.source.name,
    platform: m.platform,
    trustTier: m.source.trustTier,
    postedAt: m.postedAt,
    contentSnippet: m.contentSnippet,
    mentionType: m.mentionType,
    tokenId: m.tokenId,
    tokenAddress: m.tokenAddress,
    tokenSymbol: m.tokenSymbol,
    spamScore: m.spamScore,
    spamReason: m.spamReason,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{token.symbol}</h1>
          <Badge className={CHAIN_BADGE_CLASS[token.chain]}>{token.chain}</Badge>
          {latestFlow && (
            <Badge className={SIGNAL_BADGE_CLASS[latestFlow.signalStatus] ?? SIGNAL_BADGE_CLASS.watching}>
              {latestFlow.signalStatus}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{token.name}</p>

        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Price</div>
            <div className="font-medium tabular-nums">{latestMarket ? fmtUsd(Number(latestMarket.priceUsd)) : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Market cap</div>
            <div className="font-medium tabular-nums">
              {latestMarket ? fmtUsd(Number(latestMarket.marketCapUsd)) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Liquidity</div>
            <div className="font-medium tabular-nums">
              {latestMarket ? fmtUsd(Number(latestMarket.liquidityUsd)) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">24h volume</div>
            <div className="font-medium tabular-nums">{latestMarket ? fmtUsd(Number(latestMarket.vol24h)) : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Age</div>
            <div className="font-medium">{ageLabel}</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          {explorerAddressUrl && (
            <a
              href={explorerAddressUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              Explorer
            </a>
          )}
          <a
            href={dexScreenerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground underline-offset-4 hover:underline"
          >
            DexScreener
          </a>
        </div>
      </div>

      {/* Price + market cap chart with buy/sell markers */}
      <Card>
        <CardHeader>
          <CardTitle>Price &amp; market cap</CardTitle>
        </CardHeader>
        <CardContent>
          <PriceChart series={pricePoints} trades={tradeMarkers} />
        </CardContent>
      </Card>

      {/* Net flow chart */}
      <Card>
        <CardHeader>
          <CardTitle>Net smart-wallet flow</CardTitle>
        </CardHeader>
        <CardContent>
          <NetFlowChart points={netFlowPoints} />
        </CardContent>
      </Card>

      {/* Buyer wallets table */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Buyers</h2>
        <WalletBuyersTable rows={buyerRows} />
      </div>

      {/* Trades timeline */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Trades</h2>
        <TradesTimeline trades={timelineTrades} />
      </div>

      {/* Risk / clusters / alerts */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Risk &amp; context</h2>
        <RiskPanel flags={riskFlags} />
      </div>

      {/* Social mentions (shadow-only confluence — Task F) */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Social mentions</h2>
        <SocialSection
          mentions={socialMentionRows}
          velocity={mentionVelocity}
          uiHideThreshold={socialCfg.spam.uiHideThreshold}
        />
      </div>

      {/* Confluence (shadow-only external/internal evidence — Task E) */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Confluence</h2>
        <ConfluencePanel confluence={confluence} />
      </div>

      <p className="text-xs text-muted-foreground">
        <Link href="/tokens" className="hover:underline">
          Back to Tokens
        </Link>
      </p>
    </div>
  );
}
