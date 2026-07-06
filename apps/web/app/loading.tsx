import { PageHeaderSkeleton, CardGridSkeleton } from '@/components/layout/PageSkeleton';

// Signal Feed (default landing) loading skeleton — header + card grid, matching
// the operator-card layout the page renders.
export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardGridSkeleton cards={6} />
    </div>
  );
}
