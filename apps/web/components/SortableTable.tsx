'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

// FlowRadar — one reusable sortable + searchable table (live-recovery sprint).
// FULLY SERIALIZABLE: Server Components pass only plain data (no functions, no
// elements) across the RSC boundary. Each cell is a tagged PlainCell the
// client renders by `kind`; sort/search values are derived from the cell.
//   - click a heading to sort DESC, click again ASC, arrow shows direction;
//   - numeric/date columns sort numerically/chronologically, text alphabetically;
//   - null/unknown values always sort LAST regardless of direction;
//   - optional per-row href makes the whole row clickable (keyboard-accessible),
//     without hijacking clicks/Enter on inner links or buttons.

export type PlainCell =
  | { kind: 'token'; mint: string; display: string; logoUri: string | null; isUnknown: boolean }
  | { kind: 'text'; text: string; muted?: boolean }
  | { kind: 'badge'; text: string; className?: string }
  | { kind: 'number'; value: number | null; display: string }
  | { kind: 'usd'; value: number | null; display: string }
  | { kind: 'link'; href: string; text: string; external?: boolean };

export interface SortColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  searchable?: boolean;
}

export interface SortRow {
  id: string;
  href?: string | null;
  cells: Record<string, PlainCell>;
}

function sortValue(cell: PlainCell | undefined): number | string | null {
  if (!cell) return null;
  switch (cell.kind) {
    case 'number':
    case 'usd':
      return cell.value;
    case 'token':
      return cell.isUnknown ? cell.mint : cell.display;
    case 'text':
      return cell.text;
    case 'badge':
      return cell.text;
    case 'link':
      return cell.text;
  }
}

function searchText(cell: PlainCell | undefined): string {
  if (!cell) return '';
  switch (cell.kind) {
    case 'token':
      return `${cell.display} ${cell.mint}`;
    case 'text':
      return cell.text;
    case 'badge':
      return cell.text;
    case 'link':
      return cell.text;
    default:
      return '';
  }
}

function CellView({ cell }: { cell: PlainCell | undefined }) {
  if (!cell) return <span className="text-zinc-500">unknown</span>;
  switch (cell.kind) {
    case 'token':
      return (
        <span className="inline-flex items-center gap-2">
          {cell.logoUri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cell.logoUri} alt="" width={18} height={18} className="rounded-full" />
          ) : (
            <span className="inline-block h-[18px] w-[18px] rounded-full bg-zinc-700" />
          )}
          <Link href={`/token/${cell.mint}`} className={cell.isUnknown ? 'text-zinc-300 hover:underline' : 'text-sky-400 hover:underline'}>
            {cell.display}
          </Link>
        </span>
      );
    case 'text':
      return <span className={cell.muted ? 'text-xs text-zinc-400' : ''}>{cell.text}</span>;
    case 'badge':
      return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${cell.className ?? 'bg-zinc-500/15 text-zinc-300'}`}>{cell.text}</span>;
    case 'number':
    case 'usd':
      return cell.value === null ? <span className="text-zinc-500">{cell.display}</span> : <>{cell.display}</>;
    case 'link':
      return cell.external ? (
        <a href={cell.href} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">{cell.text}</a>
      ) : (
        <Link href={cell.href} className="text-sky-400 hover:underline">{cell.text}</Link>
      );
  }
}

export function SortableTable({
  rows,
  columns,
  rowKey,
  initialSort,
  searchPlaceholder,
  emptyText
}: {
  rows: SortRow[];
  columns: SortColumn[];
  rowKey?: string; // unused placeholder for API symmetry
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  void rowKey;
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSort?.dir ?? 'desc');
  const [query, setQuery] = useState('');

  const searchable = columns.filter((c) => c.searchable).map((c) => c.key);
  const hasSearch = searchable.length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchable.some((k) => searchText(r.cells[k]).toLowerCase().includes(q)));
  }, [rows, query, searchable]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const dirMul = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a.cells[sortKey]);
      const vb = sortValue(b.cells[sortKey]);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // nulls last, both directions
      if (vb === null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dirMul;
      return String(va).localeCompare(String(vb)) * dirMul;
    });
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

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
                const cells = columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>
                    <CellView cell={r.cells[c.key]} />
                  </td>
                ));
                const isInner = (el: HTMLElement | null) => !!el?.closest('a,button,input');
                return r.href ? (
                  <tr
                    key={r.id}
                    className="cursor-pointer transition-colors hover:bg-zinc-900/60 focus-within:bg-zinc-900/60"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isInner(e.target as HTMLElement)) window.location.href = r.href!;
                    }}
                    onClick={(e) => {
                      if (isInner(e.target as HTMLElement)) return;
                      window.location.href = r.href!;
                    }}
                  >
                    {cells}
                  </tr>
                ) : (
                  <tr key={r.id} className="hover:bg-zinc-900/40">
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
