import { PageHeaderSkeleton } from '@/components/layout/PageSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

// CSV import loading skeleton — header + an upload-form-shaped block.
export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="mt-6 flex flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}
