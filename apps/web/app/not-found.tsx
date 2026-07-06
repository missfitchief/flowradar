import Link from 'next/link';

// Root 404 (Task 32, Part B). Rendered for any unmatched route (and by an
// explicit notFound() call, e.g. a token id that doesn't exist). Themed to the
// dark shell rather than Next.js's default plain 404.
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <p className="font-mono text-4xl font-semibold text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        That page doesn&apos;t exist. It may have moved, or the address (token / wallet id) isn&apos;t tracked.
      </p>
      <Link
        href="/"
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Back to Signal Feed
      </Link>
    </div>
  );
}
