import Link from 'next/link';
import { prisma } from '@/lib/db';
import {
  getRecentMentions,
  getSocialSourceHealth,
  getSocialSignalOverlap
} from '@flowradar/db';
import { getSocialSourceStatuses } from '@flowradar/providers';
import { computeMentionVelocity, parseSettings } from '@flowradar/core';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtAge } from '@/lib/format';
import { SourceManager } from './SourceManager';
import type { ManagedSource } from './SourceManager';

// DB-backed dashboard — per-request, never frozen at build time (same
// invariant every DB page follows).
export const dynamic = 'force-dynamic';

/**
 * /social (Task E, spec §8). SHADOW-ONLY social-intelligence dashboard:
 * recent mentions feed (high-spam collapsed), mention velocity, wallet-signal
 * overlap (confluence, read-only), and a Manage-sources section with per-
 * source health. No writes here; no alerts; no FlowScore/CandidateWallet.
 */

const MODE_BADGE_CLASS: Record<'live' | 'mock' | 'missing_key' | 'stub', string> = {
  mock: 'border-transparent bg-violet-500/15 text-violet-300',
  live: 'border-transparent bg-emerald-500/15 text-emerald-300',
  missing_key: 'border-transparent bg-amber-500/15 text-amber-300',
  stub: 'border-transparent bg-zinc-500/15 text-zinc-300'
};

export default async function SocialPage() {
  const settingsRow = await prisma.settings.findFirst();
  const settings = parseSettings(settingsRow?.values ?? {});
  const social = settings.connectors.social;
  const uiHideThreshold = social.spam.uiHideThreshold;
  const velocityWindowsMin = social.velocityWindowsMin;

  const [sources, mentions, health, statuses, overlap] = await Promise.all([
    prisma.socialSource.findMany({ orderBy: { name: 'asc' } }),
    getRecentMentions(prisma, { limit: 100 }),
    getSocialSourceHealth(prisma),
    getSocialSourceStatuses(prisma),
    getSocialSignalOverlap(prisma, { windowMinutes: 1440, limit: 25 })
  ]);

  // Mention velocity (pure, computed on read). Feed it the linked/unlinked
  // mentions with the fields computeMentionVelocity needs, non-spam only via
  // its own cfg.spamMaxScore.
  const velocityInput = mentions.map((m) => ({
    tokenId: m.tokenId,
    tokenAddress: m.tokenAddress,
    authorHash: m.authorHash,
    postedAt: m.postedAt,
    spamScore: m.spamScore
  }));
  const velocity = computeMentionVelocity(velocityInput, new Date(), {
    windowsMin: velocityWindowsMin,
    spamMaxScore: uiHideThreshold - 1
  });
  // Attach a display symbol per velocity row. The velocity row itself carries
  // NO symbol (MentionVelocityRow has none), so look the symbol up from the
  // mentions list keyed by tokenId (linked) or tokenAddress (unlinked).
  const symbolByTokenId = new Map(mentions.filter((m) => m.tokenId).map((m) => [m.tokenId!, m.tokenSymbol]));
  const symbolByTokenAddress = new Map(mentions.filter((m) => m.tokenAddress).map((m) => [m.tokenAddress!, m.tokenSymbol]));
  const shortWindow = velocityWindowsMin[0];
  const midWindow = velocityWindowsMin[1] ?? velocityWindowsMin[0];
  const longWindow = velocityWindowsMin[velocityWindowsMin.length - 1];

  const statusBySource = new Map(statuses.map((s) => [s.sourceName, s]));

  // Empty state: no sources OR no mentions => honest message + add affordance.
  if (sources.length === 0 || mentions.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Social intelligence</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Shadow-only confluence evidence from configured Telegram/Discord channels. Never a primary signal;
            never fires an alert.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{sources.length === 0 ? 'No sources yet' : 'No mentions yet'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              {sources.length === 0
                ? 'Add a source below to start ingesting mentions. In MOCK_MODE the mock reader will populate the feed on the next worker pass.'
                : 'Sources are configured but no mentions have been ingested yet — run the socialIngest worker pass (or wait for its interval).'}
            </p>
          </CardContent>
        </Card>
        <div>
          <h2 className="mb-3 text-lg font-medium tracking-tight">Add a source</h2>
          <SourceManager sources={sources as unknown as ManagedSource[]} />
        </div>
      </div>
    );
  }

  // Split mentions into visible vs collapsed by the settings threshold.
  const visibleMentions = mentions.filter((m) => m.spamScore < uiHideThreshold);
  const collapsedMentions = mentions.filter((m) => m.spamScore >= uiHideThreshold);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Social intelligence</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Shadow-only confluence evidence from configured Telegram/Discord channels. Never a primary signal;
          never fires an alert.
        </p>
      </div>

      {/* Wallet + smart-money confluence */}
      <Card>
        <CardHeader>
          <CardTitle>Social + smart-money confluence</CardTitle>
        </CardHeader>
        <CardContent>
          {overlap.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tokens currently have both social mentions and wallet-driven evidence in the last 24h.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 text-right font-medium">Mentions</th>
                    <th className="px-3 py-2 text-right font-medium">Distinct authors</th>
                    <th className="px-3 py-2 text-right font-medium">Flow score</th>
                    <th className="px-3 py-2 font-medium">Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {overlap.map((row) => (
                    <tr key={row.tokenId} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-2">
                        <Link href={`/tokens/${row.tokenId}`} className="font-medium hover:underline">
                          {row.tokenSymbol}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.socialMentionCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.distinctAuthors}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.latestFlowScore ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.firedSignals.length === 0 ? '—' : row.firedSignals.map((s) => `${s.rule}/${s.severity}`).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mention velocity */}
      <Card>
        <CardHeader>
          <CardTitle>Mention velocity</CardTitle>
        </CardHeader>
        <CardContent>
          {velocity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No non-spam token mentions in the velocity windows yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 text-right font-medium">{shortWindow}m</th>
                    <th className="px-3 py-2 text-right font-medium">{midWindow}m</th>
                    <th className="px-3 py-2 text-right font-medium">{longWindow}m</th>
                    <th className="px-3 py-2 text-right font-medium">Authors ({shortWindow}m)</th>
                    <th className="px-3 py-2 text-right font-medium">Accel</th>
                  </tr>
                </thead>
                <tbody>
                  {velocity.map((v, i) => {
                    // Symbol comes from the mentions list (keyed by tokenId or
                    // tokenAddress), NOT from the velocity row — MentionVelocityRow
                    // has no symbol field.
                    const label = v.tokenId
                      ? symbolByTokenId.get(v.tokenId) ?? v.tokenAddress
                      : (v.tokenAddress ? symbolByTokenAddress.get(v.tokenAddress) : null) ?? v.tokenAddress;
                    const winCount = (w: number) => v.windows.find((x) => x.windowMin === w)?.count ?? 0;
                    const winAuthors = (w: number) => v.windows.find((x) => x.windowMin === w)?.distinctAuthors ?? 0;
                    return (
                      <tr key={v.tokenId ?? v.tokenAddress ?? `v${i}`} className="border-b border-border/50 last:border-0">
                        <td className="px-3 py-2">
                          {v.tokenId ? (
                            <Link href={`/tokens/${v.tokenId}`} className="font-medium hover:underline">{label ?? '—'}</Link>
                          ) : (
                            <span className="text-muted-foreground">unlinked · {label ?? '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{winCount(shortWindow)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{winCount(midWindow)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{winCount(longWindow)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{winAuthors(shortWindow)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{v.accel.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent mentions feed */}
      <Card>
        <CardHeader>
          <CardTitle>Recent mentions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {visibleMentions.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 pb-2 text-sm last:border-0">
              {m.tokenId ? (
                <Link href={`/tokens/${m.tokenId}`} className="font-medium hover:underline">{m.tokenSymbol ?? '—'}</Link>
              ) : (
                <span className="text-muted-foreground">unlinked · {m.tokenSymbol ?? m.tokenAddress ?? '—'}</span>
              )}
              <span className="text-xs text-muted-foreground">{m.sourceName}</span>
              <span className="text-xs text-muted-foreground">{m.platform}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.contentSnippet}</span>
              <span className="text-xs text-muted-foreground">{fmtAge(m.postedAt)} ago</span>
              {m.spamScore > 0 && (
                <Badge className="border-transparent bg-amber-500/15 text-amber-300">
                  spam {m.spamScore}{m.spamReason ? ` · ${m.spamReason}` : ''}
                </Badge>
              )}
            </div>
          ))}
          {collapsedMentions.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {collapsedMentions.length} high-spam mention{collapsedMentions.length === 1 ? '' : 's'} hidden (score ≥ {uiHideThreshold})
              </summary>
              <div className="mt-2 flex flex-col gap-2 opacity-60">
                {collapsedMentions.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="text-muted-foreground">{m.tokenSymbol ?? m.tokenAddress ?? '—'}</span>
                    <span className="text-xs text-muted-foreground">{m.sourceName}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.contentSnippet}</span>
                    <Badge className="border-transparent bg-red-500/15 text-red-400">
                      spam {m.spamScore}{m.spamReason ? ` · ${m.spamReason}` : ''}
                    </Badge>
                  </div>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {/* Manage sources + health */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Manage sources</h2>
        <SourceManager sources={sources as unknown as ManagedSource[]} />

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Platform</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">API key</th>
                <th className="px-3 py-2 font-medium">Last sync</th>
                <th className="px-3 py-2 text-right font-medium">Mentions</th>
                <th className="px-3 py-2 text-right font-medium">Scanned</th>
                <th className="px-3 py-2 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => {
                const st = statusBySource.get(h.name);
                const mode = (st?.mode ?? 'stub') as 'live' | 'mock' | 'missing_key' | 'stub';
                return (
                  <tr key={h.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium">{h.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{h.platform}</td>
                    <td className="px-3 py-2">
                      <Badge className={MODE_BADGE_CLASS[mode]} title={st?.note}>{mode}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <code className="text-muted-foreground">{h.apiKeyEnvName ?? '—'}</code>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{h.lastSyncAt ? `${fmtAge(h.lastSyncAt)} ago` : 'never'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{h.mentionCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{h.postsScanned}</td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-xs text-red-400" title={h.lastError ?? undefined}>
                      {h.lastError ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
