import { PageSkeleton } from '@/components/layout/PageSkeleton';

// Route loading skeleton (Task 32, Part B) — shown while the server component's
// DB query is in flight, replacing the blank flash with a themed placeholder.
export default function Loading() {
  return <PageSkeleton />;
}
