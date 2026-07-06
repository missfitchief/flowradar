import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shared skeleton scaffolding for route-level `loading.tsx` files. Rendered by
 * Next.js inside the app shell (app/layout.tsx's padded <main>) while a
 * server-component page's data query is in flight — replaces the previously
 * blank flash with a consistent, dark-theme placeholder.
 *
 * Two building blocks cover every page in this app:
 *  - PageHeaderSkeleton: the title + one-line description every page opens with.
 *  - TableSkeleton / CardGridSkeleton: the two body shapes (dense table pages
 *    vs card/summary pages).
 */

export function PageHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardGridSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Default whole-page skeleton: header + a table body. Most pages use this. */
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div>
      <PageHeaderSkeleton />
      <TableSkeleton rows={rows} />
    </div>
  );
}
