'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

// FlowRadar — one reusable sortable + searchable table (live-recovery sprint).
// Applied to every important operator table so sorting is consistent:
//   - click a heading to sort DESC, click again ASC, arrow shows direction;
//   - numeric/date columns sort numerically/chronologically, text alphabetically;
//   - null/unknown values always sort LAST regardless of direction;
//   - optional per-row href makes the whole row clickable (keyboard-accessible);
//   - optional search box filters across the searchable columns.

export interface Column<T> {
  key: string;
  label: string;
  /** Sort/compare value. Return null for unknown (always sorts last). */
  value: (row: T) => number | string | null;
  /** Cell renderer (defaults to the raw value). */
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  type?: 'number' | 'text' | 'date';
  /** Include this column's text in the search filter. */
  searchable?: boolean;
}

interface SortableTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Whole-row link (internal navigation). Controls inside cells still work. */
  rowHref?: (row: T) => string | null;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  searchPlaceholder?: string;
  emptyText?: string;
}

export function SortableTable<T>({ rows, columns, rowKey, rowHref, initialSort, searchPlaceholder, emptyText }: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSort?.dir ?? 'desc');
  const [query, setQuery] = useState('');

  const colOf = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    const searchCols = columns.filter((c) => c.searchable);
    return rows.filter((r) =>
      searchCols.some((c) => {
        const v = c.value(r);
        return v !== null && String(v).toLowerCase().includes(q);
      })
    );
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = colOf.get(sortKey);
    if (!col) return filtered;
    const dirMul = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      // null/unknown always last, both directions.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dirMul;
      return String(va).localeCompare(String(vb)) * dirMul;
    });
  }, [filtered, sortKey, sortDir, colOf]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const hasSearch = columns.some((c) => c.searchable);

  return (
    <div className="space-y-2">
      {hasSearch && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder ?? 'Search…'}
          className="w-full max-w-sm rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none"
        />
      )}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900 text-xs text-zinc-400">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`cursor-pointer select-none px-3 py-2 font-medium hover:text-zinc-200 ${c.align === 'right' ? 'text-right' : ''}`}
                  aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {sortKey === c.key && <span className="ml-1 text-sky-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-zinc-500">
                  {query ? 'No rows match your search.' : emptyText ?? 'No rows.'}
                </td>
              </tr>
            ) : (
              sorted.map((r) => {
                const href = rowHref?.(r) ?? null;
                const cells = columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>
                    {c.render ? c.render(r) : (c.value(r) ?? <span className="text-zinc-500">unknown</span>)}
                  </td>
                ));
                return href ? (
                  <tr
                    key={rowKey(r)}
                    className="cursor-pointer transition-colors hover:bg-zinc-900/60 focus-within:bg-zinc-900/60"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') window.location.href = href;
                    }}
                    onClick={(e) => {
                      // Don't hijack clicks on inner links/buttons.
                      if ((e.target as HTMLElement).closest('a,button')) return;
                      window.location.href = href;
                    }}
                  >
                    {cells}
                  </tr>
                ) : (
                  <tr key={rowKey(r)} className="hover:bg-zinc-900/40">
                    {cells}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Shared token-identity cell: logo + $SYMBOL / "Unknown token", short mint
 *  link, copy + explorer — used inside SortableTable render callbacks. */
export function TokenCellInner({
  mint,
  display,
  logoUri,
  isUnknown
}: {
  mint: string;
  display: string;
  logoUri: string | null;
  isUnknown: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {logoUri ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUri} alt="" width={18} height={18} className="rounded-full" />
      ) : (
        <span className="inline-block h-[18px] w-[18px] rounded-full bg-zinc-700" />
      )}
      <Link href={`/token/${mint}`} className={isUnknown ? 'text-zinc-300 hover:underline' : 'text-sky-400 hover:underline'}>
        {display}
      </Link>
    </span>
  );
}
