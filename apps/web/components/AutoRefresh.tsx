'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Polls the Overview page by re-running its server component every 30s
 * (spec §8 item 1: "30 s poll"). Renders nothing — mount this once per page.
 * No client state of its own; `router.refresh()` re-fetches the current
 * route's server-rendered payload in place (no full navigation/reload).
 */
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
