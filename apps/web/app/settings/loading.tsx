import { PageHeaderSkeleton } from '@/components/layout/PageSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

// Settings loading skeleton — header + a few form-section blocks.
export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="mt-6 flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-9 w-full max-w-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}
