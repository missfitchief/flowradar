'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
}

// Order matches binding decision #5 (Task 17) plus Task 42's own nav
// binding decision 5: Backtest + Shadow inserted after Alerts, before
// Settings — full nav reorder (Signal Feed as default landing page etc.) is
// Task 43's job, not this one.
const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/' },
  { label: 'Tokens', href: '/tokens' },
  { label: 'Wallets', href: '/wallets' },
  { label: 'Money Flow', href: '/flow' },
  { label: 'Wallet Graph', href: '/graph' },
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
