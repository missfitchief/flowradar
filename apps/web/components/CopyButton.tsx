'use client';

import { useState } from 'react';

// FlowRadar — copy-to-clipboard button (live-recovery sprint). A separate
// action so copying a mint never hijacks the row's navigation click.
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
      title={`Copy ${value}`}
      aria-label={`Copy ${label}`}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
