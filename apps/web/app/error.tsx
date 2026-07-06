'use client';

// Root error boundary (Task 32, Part B). App Router error boundaries MUST be
// client components. Catches an unhandled error thrown while rendering any
// route segment's server/client tree (e.g. a DB query failing when Postgres
// isn't up) and renders a themed recovery card with a reset() retry instead of
// Next.js's default unstyled error screen.

import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface the error to the browser console for debugging; the UI stays
    // intentionally generic (no stack trace leaked to the operator UI).
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This page hit an unexpected error. If you just started the app, make sure the database is up
        (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run db:migrate</code> then{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run db:seed</code>) and the worker is running.
      </p>
      {error.digest && <p className="font-mono text-xs text-muted-foreground/70">digest: {error.digest}</p>}
      <button
        onClick={reset}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}
