'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
}

// Product-rescue sprint: the operator navigation is decision-first. The
// primary section answers "what is interesting, why, and what happened in
// comparable historical cases"; every raw/internal tool keeps working but
// lives under Advanced instead of being presented as the main product.
const PRIMARY_ITEMS: NavItem[] = [
  { label: 'Live Opportunities', href: '/setups' },
  { label: 'Capital Staging', href: '/capital' },
  { label: 'Entities', href: '/entities' },
  { label: 'Historical Winners', href: '/historical' },
  { label: 'Watching', href: '/watching' }
];

const ADVANCED_ITEMS: NavItem[] = [
  { label: 'Intelligence Performance', href: '/intelligence' },
  { label: 'Historical Proof (replay)', href: '/proof' },
  { label: 'Signal Feed', href: '/feed' },
  { label: 'Tokens (raw)', href: '/tokens' },
  { label: 'Candidates (raw)', href: '/candidates' },
  { label: 'Money Flow', href: '/flow' },
  { label: 'Wallet Graph', href: '/graph' },
  { label: 'Overlap', href: '/overlap' },
  { label: 'Wallets (raw)', href: '/wallets' },
  { label: 'Sources', href: '/sources' },
  { label: 'Operations', href: '/operations' },
  { label: 'Social', href: '/social' },
  { label: 'Alerts', href: '/alerts' },
  { label: 'Backtest (raw)', href: '/backtest' },
  { label: 'Shadow', href: '/shadow' },
  { label: 'Settings', href: '/settings' }
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
      )}
    >
      {item.label}
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 px-3" aria-label="Primary">
      {PRIMARY_ITEMS.map((item) => (
        <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
      ))}
      <div className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
        Advanced
      </div>
      {ADVANCED_ITEMS.map((item) => (
        <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
      ))}
    </nav>
  );
}
