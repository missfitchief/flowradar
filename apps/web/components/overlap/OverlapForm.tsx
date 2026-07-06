'use client';

// FlowRadar — Multi-token Wallet Overlap Finder search form (Task 38, Wave
// 4.6, task-38-brief.md binding decision 2).
//
// Chain select (SOLANA/BSC); 2-5 token contract-address inputs (dynamic
// add/remove, min 2 max 5, validated non-empty + basic address shape per
// chain); data-source select (local/dune/provider/hybrid); params
// (min_trade_usd default 100, min_tokens_overlap default = number of tokens
// entered i.e. "traded ALL", max_results default 100).
//
// Same "this component owns no fetch logic, only assembles params and calls
// onSubmit" split as graph/SearchForm.tsx — OverlapFinder (the orchestrator)
// owns the POST /api/overlap call and running/error state.

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type OverlapChain = 'SOLANA' | 'BSC';
export type OverlapSource = 'local' | 'dune' | 'provider' | 'hybrid';

export interface OverlapFormParams {
  chain: OverlapChain;
  tokenAddresses: string[];
  source: OverlapSource;
  minTradeUsd: number;
  minTokensOverlap: number;
  maxResults: number;
}

export interface OverlapFormProps {
  initialValues?: Partial<OverlapFormParams>;
  running: boolean;
  error?: string | null;
  onSubmit: (params: OverlapFormParams) => void;
}

const MIN_TOKENS = 2;
const MAX_TOKENS = 5;

const SOURCE_DESCRIPTIONS: Record<OverlapSource, string> = {
  local: 'Local DB — direct on-chain-derived from already-tracked wallet trades. No credits, no Dune dependency.',
  dune: 'Dune query — credit-safe by default (latest cached result). Discovers NEW candidate wallets, pending validation.',
  provider: 'Provider API (birdeye top-traders) — documented-limited: no verified multi-token overlap endpoint exists yet.',
  hybrid: 'Local ∪ Dune — runs both and merges wallet results (deduped, max overlap count kept).',
};

// SOLANA = base58 alphabet, encoded length 32-44 chars; BSC = 0x + 40 hex —
// same local/dependency-light shape check as packages/db/src/csv/
// importWalletsCsv.ts's isValidAddressForChain (not imported directly since
// that helper is private to the db package's CSV-import module; this is a
// UI-form nicety, not a hard gate — the API route's own Zod schema is the
// real validation boundary).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isValidAddressForChain(address: string, chain: OverlapChain): boolean {
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  if (chain === 'BSC') return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
  return BASE58_RE.test(trimmed) && trimmed.length >= 32 && trimmed.length <= 44;
}

export function OverlapForm({ initialValues, running, error, onSubmit }: OverlapFormProps) {
  const [chain, setChain] = useState<OverlapChain>(initialValues?.chain ?? 'SOLANA');
  const [tokens, setTokens] = useState<string[]>(
    initialValues?.tokenAddresses && initialValues.tokenAddresses.length >= MIN_TOKENS
      ? initialValues.tokenAddresses
      : ['', ''],
  );
  const [source, setSource] = useState<OverlapSource>(initialValues?.source ?? 'local');
  const [minTradeUsdText, setMinTradeUsdText] = useState(String(initialValues?.minTradeUsd ?? 100));
  const [minTokensOverlapText, setMinTokensOverlapText] = useState(
    initialValues?.minTokensOverlap !== undefined ? String(initialValues.minTokensOverlap) : '',
  );
  const [maxResultsText, setMaxResultsText] = useState(String(initialValues?.maxResults ?? 100));
  const [touched, setTouched] = useState(false);

  function setToken(index: number, value: string): void {
    setTokens((prev) => prev.map((t, i) => (i === index ? value : t)));
  }

  function addToken(): void {
    setTokens((prev) => (prev.length < MAX_TOKENS ? [...prev, ''] : prev));
  }

  function removeToken(index: number): void {
    setTokens((prev) => (prev.length > MIN_TOKENS ? prev.filter((_, i) => i !== index) : prev));
  }

  const trimmedTokens = tokens.map((t) => t.trim());
  const tokenErrors = trimmedTokens.map((t) => (isValidAddressForChain(t, chain) ? null : 'required, must look like a valid address for this chain'));
  const tokensValid = tokenErrors.every((e) => e === null);
  const uniqueCount = new Set(trimmedTokens.filter((t) => t.length > 0)).size;
  const duplicatesPresent = uniqueCount !== trimmedTokens.filter((t) => t.length > 0).length;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setTouched(true);
    if (!tokensValid || duplicatesPresent) return;

    const minTradeUsd = Number.parseFloat(minTradeUsdText);
    const maxResults = Number.parseInt(maxResultsText, 10);
    const minTokensOverlapParsed = Number.parseInt(minTokensOverlapText, 10);
    const minTokensOverlap = Number.isFinite(minTokensOverlapParsed) && minTokensOverlapParsed > 0
      ? minTokensOverlapParsed
      : trimmedTokens.length; // default = "traded ALL"

    onSubmit({
      chain,
      tokenAddresses: trimmedTokens,
      source,
      minTradeUsd: Number.isFinite(minTradeUsd) ? minTradeUsd : 100,
      minTokensOverlap,
      maxResults: Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 100,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Chain</label>
          <Select value={chain} onValueChange={(v) => setChain(v as OverlapChain)} disabled={running}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SOLANA">SOLANA</SelectItem>
              <SelectItem value="BSC">BSC</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Data source</label>
          <Select value={source} onValueChange={(v) => setSource(v as OverlapSource)} disabled={running}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local DB</SelectItem>
              <SelectItem value="dune">Dune query</SelectItem>
              <SelectItem value="provider">Provider API</SelectItem>
              <SelectItem value="hybrid">Hybrid (local ∪ dune)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Min trade (USD)</label>
          <Input
            type="text"
            inputMode="decimal"
            value={minTradeUsdText}
            disabled={running}
            onChange={(e) => setMinTradeUsdText(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Max results</label>
          <Input
            type="text"
            inputMode="numeric"
            value={maxResultsText}
            disabled={running}
            onChange={(e) => setMaxResultsText(e.target.value)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{SOURCE_DESCRIPTIONS[source]}</p>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-muted-foreground">
            Token addresses ({tokens.length}/{MAX_TOKENS})
          </label>
          <button
            type="button"
            className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
            disabled={running || tokens.length >= MAX_TOKENS}
            onClick={addToken}
          >
            + Add token
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {tokens.map((token, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="text"
                placeholder={`Token ${i + 1} contract address`}
                value={token}
                disabled={running}
                aria-invalid={touched && tokenErrors[i] !== null}
                onChange={(e) => setToken(i, e.target.value)}
                className={cn(touched && tokenErrors[i] !== null && 'border-red-500/60')}
              />
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-red-400 disabled:pointer-events-none disabled:opacity-30"
                disabled={running || tokens.length <= MIN_TOKENS}
                onClick={() => removeToken(i)}
                aria-label={`Remove token ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {touched && !tokensValid && (
          <p className="mt-1 text-xs text-red-400">Every token address must be non-empty and look like a valid {chain} address.</p>
        )}
        {touched && tokensValid && duplicatesPresent && (
          <p className="mt-1 text-xs text-red-400">Token addresses must be unique.</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Min tokens overlap (default = traded ALL {trimmedTokens.length})
          </label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder={String(trimmedTokens.length)}
            value={minTokensOverlapText}
            disabled={running}
            onChange={(e) => setMinTokensOverlapText(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div>
        <Button type="submit" disabled={running}>
          {running ? 'Searching…' : 'Find overlap'}
        </Button>
      </div>
    </form>
  );
}
