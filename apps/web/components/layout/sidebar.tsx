import { SidebarNav } from '@/components/layout/sidebar-nav';

/**
 * Radar-glyph — concentric circles + a sweep line, drawn as inline SVG (no
 * image asset dependency per binding decision #5).
 */
function RadarGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0 text-sidebar-primary"
    >
      <circle cx="12" cy="12" r="9" opacity="0.35" />
      <circle cx="12" cy="12" r="5.5" opacity="0.6" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 12 L18.5 7.5" strokeWidth="1.75" />
    </svg>
  );
}

export function Sidebar() {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 py-5">
        <RadarGlyph />
        <span className="text-base font-semibold tracking-tight">FlowRadar</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        <SidebarNav />
      </div>

      <div className="border-t border-sidebar-border px-4 py-3">
        <p className="text-[11px] leading-snug text-sidebar-foreground/50">
          Analytics only — not financial advice. Labels are probabilistic
          (weak/possible/probable/strong).
        </p>
      </div>
    </aside>
  );
}
