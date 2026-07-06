'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
}

// Order per Task 43 binding decision 2 (Wave 3.5 Phase D): Signal Feed
// becomes the default landing page ('/'), the old Overview hot-table code is
// merged into /tokens (now the single dense raw-table layer). Backtest +
// Shadow (Task 42) remain reachable, placed after Alerts, before Settings.
//
// Task 36 (Wave 4.5): "Sources" (Source Health) is placed right after
// Wallets — it's an ops/pipeline-health view over the same wallet-tracking
// domain (candidate feeders that eventually become Wallet rows), so it reads
// naturally as a sibling of Wallets rather than being buried next to Settings
// (a general config page, not a wallet-pipeline concept).
const NAV_ITEMS: NavItem[] = [
  { label: 'Signal Feed', href: '/' },
  { label: 'Tokens', href: '/tokens' },
  { label: 'Money Flow', href: '/flow' },
  { label: 'Wallet Graph', href: '/graph' },
  { label: 'Wallets', href: '/wallets' },
  { label: 'Sources', href: '/sources' },
  { label: 'Alerts', href: '/alerts' },
  { label: 'Backtest', href: '/backtest' },
  { label: 'Shadow', href: '/shadow' },
  { label: 'Settings', href: '/settings' },
];

/**
 * `/` (Overview) only counts as active on an exact match; every other route
 * also matches its own sub-paths (e.g. `/tokens/abc123` highlights "Tokens")
 * so Task 9's token detail page still shows the right active nav item.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 px-3" aria-label="Primary">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
