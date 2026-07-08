import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtAge } from '@/lib/format';
import type { MentionVelocityRow } from '@flowradar/core';

/** One mention row, projected at the page's query boundary (Dates -> Date is
 *  fine for a server component; only client charts need ISO strings). */
export interface SocialMentionRowVM {
  id: string;
  sourceName: string;
  platform: string;
  trustTier: string;
  postedAt: Date;
  contentSnippet: string;
  mentionType: string;
  tokenId: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  spamScore: number;
  spamReason: string | null;
}

export interface SocialSectionProps {
  mentions: SocialMentionRowVM[];
  /** This token's velocity rows (usually 0 or 1 row after keying by token). */
  velocity: MentionVelocityRow[];
  /** From settings.connectors.social.spam.uiHideThreshold — display filter. */
  uiHideThreshold: number;
}

const TRUST_BADGE_CLASS: Record<string, string> = {
  high: 'border-transparent bg-emerald-500/15 text-emerald-300',
  medium: 'border-transparent bg-zinc-500/15 text-zinc-300',
  low: 'border-transparent bg-amber-500/15 text-amber-400',
};

const WINDOW_LABEL: Record<number, string> = { 60: '1h', 360: '6h', 1440: '24h' };

/**
 * Token-detail "Social mentions" section (Task F, spec §8) — SHADOW-ONLY
 * confluence evidence. Read-only: it renders this token's spam-filtered
 * recent SocialMention rows and its mention velocity. It does NOT touch the
 * flow score, signal status, wallet scoring, or emit any alert — the social
 * subsystem is entirely separate from the wallet-candidate/scoring pipeline.
 *
 * Spam is filtered for DISPLAY, never dropped from data: mentions with
 * spamScore >= uiHideThreshold are greyed + reason-badged, not removed
 * (spec §4). Mentions whose token didn't resolve (tokenId === null) still
 * render, shown as "unlinked" with their raw address/ticker (spec §10).
 */
export function SocialSection({ mentions, velocity, uiHideThreshold }: SocialSectionProps) {
  // This token has at most one velocity row (keyed by token); take the first.
  const vel = velocity[0] ?? null;
  // Per-window count/distinctAuthors live in vel.windows[] (MentionVelocityRow
  // has no counts/distinctAuthors Record). Sort ascending by window length.
  const windows = vel ? [...vel.windows].sort((a, b) => a.windowMin - b.windowMin) : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Mention velocity summary */}
      <Card>
        <CardHeader>
          <CardTitle>Mention velocity</CardTitle>
        </CardHeader>
        <CardContent>
          {!vel ? (
            <p className="text-sm text-muted-foreground">
              No mention velocity — no non-spam mentions in the tracked windows.
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              {windows.map((w) => (
                <div key={w.windowMin}>
                  <div className="text-xs text-muted-foreground">{WINDOW_LABEL[w.windowMin] ?? `${w.windowMin}m`}</div>
                  <div className="font-medium tabular-nums">
                    {w.count}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({w.distinctAuthors} authors)
                    </span>
                  </div>
                </div>
              ))}
              <div>
                <div className="text-xs text-muted-foreground">Accel</div>
                <div className="font-medium tabular-nums">{vel.accel.toFixed(2)}×</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent mentions feed (spam-greyed, unlinked-safe) */}
      <Card>
        <CardHeader>
          <CardTitle>Recent mentions</CardTitle>
        </CardHeader>
        <CardContent>
          {mentions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No social mentions for this token yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {mentions.map((m) => {
                const isSpam = m.spamScore >= uiHideThreshold;
                return (
                  <li
                    key={m.id}
                    className={
                      'flex flex-col gap-1 rounded-md border border-border/50 p-3 ' +
                      (isSpam ? 'opacity-40' : '')
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{m.sourceName}</span>
                      <span>{m.platform}</span>
                      <Badge className={TRUST_BADGE_CLASS[m.trustTier] ?? TRUST_BADGE_CLASS.medium}>
                        {m.trustTier}
                      </Badge>
                      <span>{fmtAge(m.postedAt)} ago</span>
                      {m.tokenId === null && (
                        <Badge className="border-transparent bg-zinc-800/50 text-zinc-400">
                          unlinked · {m.tokenSymbol ? `$${m.tokenSymbol}` : m.tokenAddress ?? m.mentionType}
                        </Badge>
                      )}
                      {isSpam && m.spamReason && (
                        <Badge className="border-transparent bg-red-500/15 text-red-400">
                          {m.spamReason}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm">{m.contentSnippet}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Shadow-only social evidence — not a scoring or alert input.{' '}
        <Link href="/social" className="hover:underline">
          View all social mentions
        </Link>
      </p>
    </div>
  );
}
