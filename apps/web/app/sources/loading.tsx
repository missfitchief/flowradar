import { PageHeaderSkeleton, CardGridSkeleton, TableSkeleton } from '@/components/layout/PageSkeleton';

// Source Health loading skeleton — header + summary cards + source table.
export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardGridSkeleton cards={4} />
      <TableSkeleton rows={6} />
    </div>
  );
}
