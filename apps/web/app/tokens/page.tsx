import Link from 'next/link';
import { prisma } from '@/lib/db';

// DB-backed dashboard — must render per-request, never freeze at build time.
export const dynamic = 'force-dynamic';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Server component — proves DB -> server-component wiring end to end
// (binding decision #6). Every other route is a static one-line placeholder;
// this one actually queries the seeded LITE Postgres DB via @flowradar/db's
// prisma singleton.
export default async function TokensPage() {
  const tokens = await prisma.token.findMany({
    orderBy: { symbol: 'asc' },
  });

  // One "latest flow snapshot" query per token (small, fixed-size seeded
  // dataset — ~29 tokens — so N+1 here is a non-issue; a later task can
  // switch to a single grouped query if the token count ever grows).
  const latestFlowScores = await Promise.all(
    tokens.map((token) =>
      prisma.tokenFlowSnapshot.findFirst({
        where: { tokenId: token.id },
        orderBy: { ts: 'desc' },
        select: { flowScore: true },
      }),
    ),
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {tokens.length} tracked token{tokens.length === 1 ? '' : 's'}.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Chain</TableHead>
              <TableHead className="text-right">Flow score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token, i) => {
              const flowScore = latestFlowScores[i]?.flowScore;
              return (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">
                    <Link href={`/tokens/${token.id}`} className="hover:underline">
                      {token.symbol}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{token.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{token.chain}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {flowScore !== undefined ? flowScore.toFixed(1) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
