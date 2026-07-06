// FlowRadar — hard-framing banner (Task 42 binding decision, Spec §5c).
//
// BINDING, verbatim copy — must appear, unmodified, on BOTH /backtest and
// /shadow. Asserted by test as a string-presence check (see the task brief:
// "This copy is asserted in a component test... not just written once").
// Always visible (not dismissible, no collapsed/expandable state) — the
// whole point is that a trader can never scroll past this page without
// seeing it.

export const FRAMING_BANNER_TEXT =
  'Mock data proves the code path only. Only historical replay and shadow-mode results on real market data validate signal quality.';

export function FramingBanner() {
  return (
    <div
      role="note"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <span className="font-medium text-amber-300">Read this first: </span>
      {FRAMING_BANNER_TEXT}
    </div>
  );
}
