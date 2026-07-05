import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';

interface TokenDetailPageProps {
  params: Promise<{ id: string }>;
}

// Shell only — proves the [id] route + DB row fetch works end to end. Full
// detail view (market data, flow chart, buyer/exit tables, signals) arrives
// in Task 9.
export default async function TokenDetailPage({ params }: TokenDetailPageProps) {
  const { id } = await params;
  const token = await prisma.token.findUnique({ where: { id } });

  if (!token) notFound();

  return (
    <div>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{token.symbol}</h1>
        <Badge variant="secondary">{token.chain}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{token.name}</p>
      <p className="mt-4 text-sm text-muted-foreground">Token detail arrives in Task 9.</p>
    </div>
  );
}
