import Link from 'next/link';

// FlowRadar — SignalSection (Task 43 binding decision 3): a titled section
// wrapper for the Signal Feed's 7 sections. Renders a responsive grid of
// cards (1-col mobile / 2-col >=lg per binding decision 4), caps display at
// 6, and shows a "view all ->" link to the section's fuller page plus an
// explicit empty-state one-liner when there are zero entries.

export interface SignalSectionProps {
  title: string;
  description?: string;
  emptyMessage: string;
  viewAllHref: string;
  count: number;
  cap?: number;
  children: React.ReactNode;
}

const DEFAULT_CAP = 6;

export function SignalSection({
  title,
  description,
  emptyMessage,
  viewAllHref,
  count,
  cap = DEFAULT_CAP,
  children,
}: SignalSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {count > 0 && (
          <Link href={viewAllHref} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            view all →
          </Link>
        )}
      </div>

      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>
      )}

      {count > cap && (
        <p className="text-xs text-muted-foreground">
          Showing {cap} of {count}. <Link href={viewAllHref} className="underline-offset-4 hover:underline">View all →</Link>
        </p>
      )}
    </section>
  );
}
