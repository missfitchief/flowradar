// FlowRadar — display formatters shared by every page in apps/web.
//
// Kept dependency-free (no @flowradar/core import, no framework import) per
// binding decision #7: these are UI-only presentation helpers, not domain
// logic, so they stay local to apps/web/lib rather than packages/core. No
// unit tests ship with this task (no test infra exists for apps/web yet —
// verification is the preview-snapshot boot check instead), but every
// function is a pure `(input) => string` with no I/O, so they're trivially
// testable later if that changes.

/**
 * Adaptive USD formatter: $1.2M / $45k / $0.0012.
 *
 * Bands (abs value of n):
 *   >= 1_000_000_000  -> $X.XB
 *   >= 1_000_000      -> $X.XM
 *   >= 1_000          -> $X.Xk
 *   >= 1              -> $X.XX (2 decimals, normal cents-style USD)
 *   >  0               -> $0.00XX (up to 4 significant decimal places for
 *                          sub-$1 amounts, e.g. token micro-prices) — falls
 *                          back to up to 6 decimals if still rounds to 0
 *                          at 4, so a genuinely tiny nonzero price never
 *                          prints as "$0.00".
 *   == 0               -> $0.00
 * Negative numbers keep their sign in front of the $ (e.g. -$45k).
 */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';

  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);

  if (abs === 0) return '$0.00';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;

  // Sub-$1: show up to 4 decimals; if that still rounds to 0.0000, extend to
  // 6 so a real (if tiny) price doesn't display as zero.
  const four = abs.toFixed(4);
  if (Number.parseFloat(four) > 0) return `${sign}$${four}`;
  return `${sign}$${abs.toFixed(6)}`;
}

/** Signed percentage: +12.3% / -4.0% / +0.0%. Input is already a percentage value (12.3, not 0.123). */
export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '+0.0%';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '+';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

/**
 * Age since `date`, coarsened to its two largest non-zero units: "2d 4h" /
 * "3h 12m" / "5m 10s" / "just now" (age < 1s). Always relative to now.
 */
export function fmtAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 1) return 'just now';

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Shortens a chain address to ABCD…WXYZ (first 4 + ellipsis + last 4). Returns short strings (<=10 chars) unchanged. */
export function shortAddr(a: string): string {
  if (a.length <= 10) return a;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
