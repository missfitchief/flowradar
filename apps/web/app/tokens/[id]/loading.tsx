import { PageHeaderSkeleton, CardGridSkeleton, TableSkeleton } from '@/components/layout/PageSkeleton';

// Token detail loading skeleton — header + metric cards + a buyers table.
export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardGridSkeleton cards={4} />
      <TableSkeleton rows={6} />
    </div>
  );
}
