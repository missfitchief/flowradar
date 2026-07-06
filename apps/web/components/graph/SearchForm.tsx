'use client';

// FlowRadar — Wallet Graph Finder search form (Task 21 binding decision 3).
//
// Spec Module 6 input surface, in full: chain, root address, mode (with
// one-line descriptions per mode), max depth, min transfer USD, six
// include/exclude toggles, and two caps (max nodes/edges). All numeric
// fields use plain text inputs + Number.parseFloat/parseInt (same convention
// as SettingsForm's NumberField — avoids native <input type="number"> quirks
// like scroll-to-increment) rather than <input type="number">.
//
// This component owns no fetch/poll logic itself — it only assembles a
// GraphSearchParams-shaped object and calls the `onSubmit` prop it's given;
// GraphExplorer (the orchestrator) owns the POST /api/graph call, the
// running/error state, and disabling the form while a search is in flight.

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type GraphChain = 'SOLANA' | 'BSC';
export type GraphMode = 'DIRECT' | 'CAPITAL_FLOW' | 'ENTITY_DISCOVERY' | 'FULL_RAW';

export interface GraphSearchFormParams {
  chain: GraphChain;
  rootAddress: string;
  mode: GraphMode;
  maxDepth: number;
  minTransferUsd: number;
  includeNative: boolean;
  includeToken: boolean;
  includeSwaps: boolean;
  includeBridges: boolean;
  includeCex: boolean;
  excludeRoutersPoolsContracts: boolean;
  maxNodes: number;
  maxEdges: number;
}

export interface SearchFormProps {
  /** Prefills the form — used when rehydrating from a recent/linked search (binding decision 8). */
  initialValues?: Partial<GraphSearchFormParams>;
  /** True while GraphExplorer's POST /api/graph is in flight — disables every field + the submit button. */
  running: boolean;
  /** Inline 4xx error message from the last submit attempt, if any. */
  error?: string | null;
  onSubmit: (params: GraphSearchFormParams) => void;
}

const DEFAULTS: GraphSearchFormParams = {
  chain: 'SOLANA',
  rootAddress: '',
  mode: 'CAPITAL_FLOW',
  maxDepth: 3,
  minTransferUsd: 100,
  includeNative: false,
  includeToken: false,
  includeSwaps: false,
  includeBridges: true,
  includeCex: true,
  excludeRoutersPoolsContracts: true,
  maxNodes: 5000,
  maxEdges: 25000,
};

const MODE_DESCRIPTIONS: Record<GraphMode, string> = {
  DIRECT: 'Only direct wallet-to-wallet transfers — no swap/bridge/CEX hops.',
  CAPITAL_FLOW: 'Follows where value actually goes, through swaps/bridges/CEX deposits.',
  ENTITY_DISCOVERY: 'Widens expansion to surface likely same-owner wallets.',
  FULL_RAW: 'Every observed edge, unfiltered — largest and slowest graph.',
};

const MODE_ORDER: GraphMode[] = ['DIRECT', 'CAPITAL_FLOW', 'ENTITY_DISCOVERY', 'FULL_RAW'];

interface ToggleSpec {
  key: keyof Pick<
    GraphSearchFormParams,
    'includeNative' | 'includeToken' | 'includeSwaps' | 'includeBridges' | 'includeCex' | 'excludeRoutersPoolsContracts'
  >;
  label: string;
}

const TOGGLES: ToggleSpec[] = [
  { key: 'includeNative', label: 'Include native transfers' },
  { key: 'includeToken', label: 'Include token transfers' },
  { key: 'includeSwaps', label: 'Include swaps' },
  { key: 'includeBridges', label: 'Include bridges' },
  { key: 'includeCex', label: 'Include CEX' },
  { key: 'excludeRoutersPoolsContracts', label: 'Exclude routers/pools/contracts' },
];

export function SearchForm({ initialValues, running, error, onSubmit }: SearchFormProps) {
  const [values, setValues] = useState<GraphSearchFormParams>({ ...DEFAULTS, ...initialValues });
  const [maxDepthText, setMaxDepthText] = useState(String(values.maxDepth));
  const [minTransferText, setMinTransferText] = useState(String(values.minTransferUsd));
  const [maxNodesText, setMaxNodesText] = useState(String(values.maxNodes));
  const [maxEdgesText, setMaxEdgesText] = useState(String(values.maxEdges));
  const [addressTouched, setAddressTouched] = useState(false);

  function set<K extends keyof GraphSearchFormParams>(key: K, value: GraphSearchFormParams[K]): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  const addressEmpty = values.rootAddress.trim().length === 0;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setAddressTouched(true);
    if (addressEmpty) return;
    onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Chain</label>
          <Select value={values.chain} onValueChange={(v) => set('chain', v as GraphChain)} disabled={running}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SOLANA">SOLANA</SelectItem>
              <SelectItem value="BSC">BSC</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="sm:col-span-2 md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Wallet address</label>
          <Input
            type="text"
            placeholder="Root wallet address"
            value={values.rootAddress}
            disabled={running}
            aria-invalid={addressTouched && addressEmpty}
            onChange={(e) => set('rootAddress', e.target.value)}
            onBlur={() => setAddressTouched(true)}
            className={cn(addressTouched && addressEmpty && 'border-red-500/60')}
          />
          {addressTouched && addressEmpty && <p className="mt-1 text-xs text-red-400">Wallet address is required.</p>}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Mode</label>
          <Select value={values.mode} onValueChange={(v) => set('mode', v as GraphMode)} disabled={running}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_ORDER.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">{MODE_DESCRIPTIONS[values.mode]}</p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Max depth</label>
          <Input
            type="text"
            inputMode="numeric"
            value={maxDepthText}
            disabled={running}
            onChange={(e) => {
              setMaxDepthText(e.target.value);
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n > 0) set('maxDepth', n);
            }}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Min transfer (USD)</label>
          <Input
            type="text"
            inputMode="decimal"
            value={minTransferText}
            disabled={running}
            onChange={(e) => {
              setMinTransferText(e.target.value);
              const n = Number.parseFloat(e.target.value);
              if (Number.isFinite(n) && n >= 0) set('minTransferUsd', n);
            }}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Max nodes</label>
          <Input
            type="text"
            inputMode="numeric"
            value={maxNodesText}
            disabled={running}
            onChange={(e) => {
              setMaxNodesText(e.target.value);
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n > 0) set('maxNodes', n);
            }}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Max edges</label>
          <Input
            type="text"
            inputMode="numeric"
            value={maxEdgesText}
            disabled={running}
            onChange={(e) => {
              setMaxEdgesText(e.target.value);
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n > 0) set('maxEdges', n);
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {TOGGLES.map((toggle) => (
          <label key={toggle.key} className="flex items-center gap-2 text-sm">
            <Switch
              checked={values[toggle.key]}
              disabled={running}
              onCheckedChange={(checked) => set(toggle.key, checked)}
            />
            {toggle.label}
          </label>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div>
        <Button type="submit" disabled={running}>
          {running ? 'Running…' : 'Run search'}
        </Button>
      </div>
    </form>
  );
}
