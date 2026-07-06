// FlowRadar — Money Flow summary cards (Task 24 binding decision 6 /
// product brief Module 9 (Money Flow page) / plan Task 24).
//
// 4 small stat cards, each a top-1 readout (biggest value driving the card).
// Two cards use a documented proxy metric rather than a purpose-built query,
// since the underlying "fresh-wallet entry" / "cross-wallet funder" signals
// don't have their own dedicated aggregate table yet (Rule E / funding-graph
// analytics are Wave-3-adjacent, not this task's scope):
//   - "Biggest recent exit" and "Biggest profit landing" read directly off
//     ProfitRotationSignal (source side = exit, dest side = landing) — exact
//     metrics, not a proxy.
//   - "Biggest fresh-wallet entry" proxies off the same rotation rows' dest
//     side (the dest wallet's buy that completes the rotation) since a
//     dedicated "wallet funded then bought within N minutes" feed (Rule E)
//     isn't queried by this page.
//   - "Top funder (by tracked transfers out)" proxies off MoneyFlowEdge
//     `transfer` out-degree (count) rather than a full funding-graph
//     traversal, computed server-side in page.tsx and passed in as a plain row.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtUsd, shortAddr } from '@/lib/format';

export interface FlowSummaryCardsProps {
  biggestExit: { walletAddress: string; tokenSymbol: string; realizedProfitUsd: number } | null;
  biggestLanding: { walletAddress: string; tokenSymbol: string; transferredValueUsd: number } | null;
  biggestFreshEntry: { walletAddress: string; tokenSymbol: string; transferredValueUsd: number } | null;
  topFunder: { address: string; outDegree: number; totalSentUsd: number } | null;
}

export function FlowSummaryCards({
  biggestExit,
  biggestLanding,
  biggestFreshEntry,
  topFunder,
}: FlowSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xs text-muted-foreground">Biggest recent exit</CardTitle>
        </CardHeader>
        <CardContent>
          {biggestExit ? (
            <>
              <div className="text-xl font-semibold tabular-nums text-emerald-400">
                {fmtUsd(biggestExit.realizedProfitUsd)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                ${biggestExit.tokenSymbol} · <code>{shortAddr(biggestExit.walletAddress)}</code>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No exits detected yet.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs text-muted-foreground">Biggest profit landing</CardTitle>
        </CardHeader>
        <CardContent>
          {biggestLanding ? (
            <>
              <div className="text-xl font-semibold tabular-nums">{fmtUsd(biggestLanding.transferredValueUsd)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                ${biggestLanding.tokenSymbol} · <code>{shortAddr(biggestLanding.walletAddress)}</code>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No landings detected yet.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs text-muted-foreground">Biggest fresh-wallet entry*</CardTitle>
        </CardHeader>
        <CardContent>
          {biggestFreshEntry ? (
            <>
              <div className="text-xl font-semibold tabular-nums">
                {fmtUsd(biggestFreshEntry.transferredValueUsd)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                ${biggestFreshEntry.tokenSymbol} · <code>{shortAddr(biggestFreshEntry.walletAddress)}</code>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No fresh entries detected yet.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs text-muted-foreground">Top funder (tracked out-transfers)*</CardTitle>
        </CardHeader>
        <CardContent>
          {topFunder ? (
            <>
              <div className="text-xl font-semibold tabular-nums">{topFunder.outDegree}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                <code>{shortAddr(topFunder.address)}</code> · {fmtUsd(topFunder.totalSentUsd)} sent
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No funder activity detected yet.</div>
          )}
        </CardContent>
      </Card>

      <p className="col-span-full text-xs text-muted-foreground">
        * Proxy metric — derived from rotation/transfer rows this page already queries, not a dedicated
        fresh-wallet or funding-graph feed.
      </p>
    </div>
  );
}
