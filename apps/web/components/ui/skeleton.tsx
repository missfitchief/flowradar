import { cn } from '@/lib/utils';

/**
 * Minimal shimmer placeholder used by route `loading.tsx` skeletons. Pure
 * presentational — a muted, pulsing block sized by the caller's className.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted/60', className)} {...props} />;
}
