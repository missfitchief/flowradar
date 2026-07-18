'use client';

// FlowRadar — Settings form (Task 17 binding decision 2).
//
// Client component. Loads its initial state from the server-fetched Settings
// object (app/settings/page.tsx), lets the user edit every leaf value via a
// plain text input (binding decision 4: text inputs + parseFloat, not
// <input type="number"> — avoids browser number-input quirks like scroll-to-
// increment and locale-dependent decimal separators), and PUTs the FULL
// edited object to /api/settings on save (binding decision 3: no partial
// patch). The server route is the single source of truth for validity —
// this form does its own lightweight "is this parseable as a finite number"
// check purely so a stray non-numeric keystroke doesn't silently coerce to
// NaN before the user notices, but the actual business-rule validation
// (mcapMin < mcapMax, etc.) only ever happens server-side via parseSettings,
// and its zod issue list is surfaced verbatim on save.
//
// Units (binding decision 4 — read from packages/core/src/settings.ts +
// packages/core/src/rules/ruleC.ts directly, not guessed):
//   - Whole percents (0-100 scale): rules.A.maxSoldPct, rules.B.maxSellToBuyPct,
//     rules.C.maxSingleBlockBuysPct, rules.E.min/maxBuyToFundingPct,
//     rules.F.min/maxValueMatchPct, rules.G.minExitedPct/exitPositionSoldPct/
//     liquidityDropPct/mcapPumpPct.
//   - 0-1 fractions (displayed as %, stored/sent as a fraction):
//     profitableWallet.minWinRate, rules.C.minHumanRatio/maxBotRatio/
//     minFundingRootsPct (ruleC.ts's own `humanRatio >= C.minHumanRatio`
//     comparison proves these are raw 0-1 ratios despite minFundingRootsPct's
//     "Pct" name — NOT a 0-100 percent like maxSoldPct).
//   - entityConfidenceThreshold: whole 0-100 scale (mirrors Signal severity
//     conventions elsewhere in the app, NOT a fraction).
//   - Multipliers (×): rules.A.inflowSpikeMult, rules.B.maxMcapExpansion,
//     rules.D.minBuySellRatio.
//   - USD amounts, minute/hour windows, and plain counts are unitless/self-
//     explanatory and labeled with their literal unit (USD, min, hours).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Settings } from '@flowradar/core';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface ProviderStatusRow {
  name: string;
  chain: 'SOLANA' | 'ETHEREUM' | 'BASE' | 'ARBITRUM' | 'BSC';
  capability: string;
  mode: 'live' | 'mock' | 'missing_key' | 'stub';
  note?: string;
}

export interface EnvPresence {
  HELIUS_API_KEY: boolean;
  BIRDEYE_API_KEY: boolean;
  BSCSCAN_API_KEY: boolean;
  TELEGRAM_BOT_TOKEN: boolean;
  TELEGRAM_CHAT_ID: boolean;
}

export interface RegistryStats {
  total: number;
  static: number;
  mock: number;
}

export interface SettingsFormProps {
  initialSettings: Settings;
  providerStatuses: ProviderStatusRow[];
  envPresence: EnvPresence;
  registryStats: RegistryStats;
}

// ---------------------------------------------------------------------------
// Generic deep-set helper — settings is a plain nested JSON object, so a
// single "set the value at this path" helper covers every field in the form
// without one useState per leaf (7 rules x ~5-10 fields each would otherwise
// mean 50+ separate state variables).
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function setPath(obj: Settings, path: readonly string[], value: unknown): Settings {
  if (path.length === 0) return obj as unknown as Settings;
  const [head, ...rest] = path;
  const objRecord = obj as unknown as Json;
  if (rest.length === 0) {
    return { ...objRecord, [head]: value } as unknown as Settings;
  }
  const child = (objRecord[head] as Json | undefined) ?? {};
  return {
    ...objRecord,
    [head]: setPath(child as unknown as Settings, rest, value),
  } as unknown as Settings;
}

function getPath(obj: Settings, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// NumberField — text input with parseFloat validation (binding decision 4).
// `displayScale` converts a stored fraction (e.g. 0.35) to/from its displayed
// percent (35) — omit for fields that are already in their display unit.
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string;
  unit?: string;
  value: number;
  onChange: (next: number) => void;
  /** e.g. 100 to display a stored 0-1 fraction as a 0-100 percent. Defaults to 1 (no scaling). */
  displayScale?: number;
}

function NumberField({ label, unit, value, onChange, displayScale = 1 }: NumberFieldProps) {
  const displayValue = value * displayScale;
  const [text, setText] = useState(String(displayValue));
  const [invalid, setInvalid] = useState(false);

  function handleChange(next: string): void {
    setText(next);
    const num = Number.parseFloat(next);
    if (next.trim() === '' || !Number.isFinite(num)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(num / displayScale);
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {unit && <span className="ml-1 text-muted-foreground/70">({unit})</span>}
      </label>
      <Input
        data-field={label}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        aria-invalid={invalid}
        className={cn(invalid && 'border-red-500/60')}
      />
      {invalid && <p className="mt-1 text-xs text-red-400">Enter a valid number.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// Rule metadata — labels/units per field, per rule (binding decision 4).
// ---------------------------------------------------------------------------

interface FieldSpec {
  path: string[];
  label: string;
  unit?: string;
  displayScale?: number;
}

const RULE_FIELDS: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', { name: string; fields: FieldSpec[] }> = {
  A: {
    name: 'Coordinated Accumulation',
    fields: [
      { path: ['rules', 'A', 'watchMinWallets'], label: 'Watch min wallets', unit: 'wallets' },
      { path: ['rules', 'A', 'minWallets'], label: 'Min wallets (HIGH)', unit: 'wallets' },
      { path: ['rules', 'A', 'windowMin'], label: 'Window', unit: 'min' },
      { path: ['rules', 'A', 'minBuyVolumeUsd'], label: 'Min buy volume', unit: 'USD' },
      { path: ['rules', 'A', 'maxSoldPct'], label: 'Max sold', unit: '%' },
      { path: ['rules', 'A', 'mcapMin'], label: 'Mcap min', unit: 'USD' },
      { path: ['rules', 'A', 'mcapMax'], label: 'Mcap max', unit: 'USD' },
      { path: ['rules', 'A', 'minLiquidityUsd'], label: 'Min liquidity', unit: 'USD' },
      { path: ['rules', 'A', 'maxTokenAgeDays'], label: 'Max token age', unit: 'days' },
      { path: ['rules', 'A', 'inflowSpikeMult'], label: 'Inflow spike', unit: '×' },
    ],
  },
  B: {
    name: 'Slow Accumulation',
    fields: [
      { path: ['rules', 'B', 'baseWallets'], label: 'Base wallets', unit: 'wallets' },
      { path: ['rules', 'B', 'targetWallets'], label: 'Target wallets', unit: 'wallets' },
      { path: ['rules', 'B', 'windowMin'], label: 'Window', unit: 'min' },
      { path: ['rules', 'B', 'maxMcapExpansion'], label: 'Max mcap expansion', unit: '×' },
      { path: ['rules', 'B', 'maxSellToBuyPct'], label: 'Max sell/buy', unit: '%' },
    ],
  },
  C: {
    name: 'Organic Distribution',
    fields: [
      { path: ['rules', 'C', 'minHumanRatio'], label: 'Min human ratio', unit: '%', displayScale: 100 },
      { path: ['rules', 'C', 'maxBotRatio'], label: 'Max bot ratio', unit: '%', displayScale: 100 },
      { path: ['rules', 'C', 'maxSingleBlockBuysPct'], label: 'Max single-block buys', unit: '%' },
      { path: ['rules', 'C', 'minFundingRoots'], label: 'Min funding roots', unit: 'wallets' },
      { path: ['rules', 'C', 'minFundingRootsPct'], label: 'Min funding roots ratio', unit: '%', displayScale: 100 },
    ],
  },
  D: {
    name: 'Whale Entry',
    fields: [
      { path: ['rules', 'D', 'minWhaleBuyUsd'], label: 'Min whale buy', unit: 'USD' },
      { path: ['rules', 'D', 'minWallets'], label: 'Min wallets', unit: 'wallets' },
      { path: ['rules', 'D', 'minBuySellRatio'], label: 'Min buy/sell ratio', unit: '×' },
    ],
  },
  E: {
    name: 'Funded Fresh Wallets',
    fields: [
      { path: ['rules', 'E', 'minDelayMin'], label: 'Min delay', unit: 'min' },
      { path: ['rules', 'E', 'maxDelayMin'], label: 'Max delay', unit: 'min' },
      { path: ['rules', 'E', 'maxMcap'], label: 'Max mcap', unit: 'USD' },
      { path: ['rules', 'E', 'minBuyToFundingPct'], label: 'Min buy/funding', unit: '%' },
      { path: ['rules', 'E', 'maxBuyToFundingPct'], label: 'Max buy/funding', unit: '%' },
    ],
  },
  F: {
    name: 'Profit Rotation',
    fields: [
      { path: ['rules', 'F', 'minRealizedProfitUsd'], label: 'Min realized profit', unit: 'USD' },
      { path: ['rules', 'F', 'maxTransferDelayHours'], label: 'Max transfer delay', unit: 'hours' },
      { path: ['rules', 'F', 'minValueMatchPct'], label: 'Min value match', unit: '%' },
      { path: ['rules', 'F', 'maxValueMatchPct'], label: 'Max value match', unit: '%' },
      { path: ['rules', 'F', 'maxBuyDelayMin'], label: 'Max buy delay', unit: 'min' },
      { path: ['rules', 'F', 'maxMcap'], label: 'Max mcap', unit: 'USD' },
    ],
  },
  G: {
    name: 'Smart Money Exit',
    fields: [
      { path: ['rules', 'G', 'minExitedPct'], label: 'Min exited', unit: '%' },
      { path: ['rules', 'G', 'exitPositionSoldPct'], label: 'Exit position sold', unit: '%' },
      { path: ['rules', 'G', 'liquidityDropPct'], label: 'Liquidity drop', unit: '%' },
      { path: ['rules', 'G', 'liquidityDropWindowMin'], label: 'Liquidity drop window', unit: 'min' },
      { path: ['rules', 'G', 'mcapPumpPct'], label: 'Mcap pump', unit: '%' },
      { path: ['rules', 'G', 'mcapPumpWindowHours'], label: 'Mcap pump window', unit: 'hours' },
      { path: ['rules', 'G', 'maxNewSmartBuyers'], label: 'Max new smart buyers', unit: 'wallets' },
    ],
  },
};

const RULE_ORDER: (keyof typeof RULE_FIELDS)[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const MODE_BADGE_CLASS: Record<ProviderStatusRow['mode'], string> = {
  mock: 'border-transparent bg-violet-500/15 text-violet-300',
  live: 'border-transparent bg-emerald-500/15 text-emerald-300',
  missing_key: 'border-transparent bg-amber-500/15 text-amber-400',
  stub: 'border-transparent bg-zinc-500/15 text-zinc-400',
};

type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; issues: string[] };
type TestAlertState = { status: 'idle' } | { status: 'sending' } | { status: 'done'; deliveryStatus: string };

export function SettingsForm({ initialSettings, providerStatuses, envPresence, registryStats }: SettingsFormProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [testAlertState, setTestAlertState] = useState<TestAlertState>({ status: 'idle' });
  // Bumped on every successful save. Threaded into every NumberField's `key`
  // below so a save remounts each field with a fresh initial `text` derived
  // from the just-saved (possibly server-normalized) value — NumberField only
  // seeds its local text state once per mount, so without this a save that
  // changes a value server-side (there currently isn't one, but the contract
  // shouldn't rely on that) would leave the displayed text silently stale.
  const [formVersion, setFormVersion] = useState(0);

  function update(path: string[], value: unknown): void {
    setSettings((prev) => setPath(prev, path, value));
    setSaveState({ status: 'idle' });
  }

  function num(path: string[]): number {
    const v = getPath(settings, path);
    return typeof v === 'number' ? v : 0;
  }

  async function handleSave(): Promise<void> {
    setSaveState({ status: 'saving' });
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const body = await response.json();

      if (!response.ok) {
        const issues: string[] = Array.isArray(body.issues)
          ? body.issues.map((i: { path: string; message: string }) => (i.path ? `${i.path}: ${i.message}` : i.message))
          : [body.error ?? `save failed (HTTP ${response.status})`];
        setSaveState({ status: 'error', issues });
        return;
      }

      setSettings(body.settings as Settings);
      setSaveState({ status: 'saved' });
      setFormVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setSaveState({ status: 'error', issues: [err instanceof Error ? err.message : String(err)] });
    }
  }

  async function handleTestAlert(): Promise<void> {
    setTestAlertState({ status: 'sending' });
    try {
      const response = await fetch('/api/alerts/test', { method: 'POST' });
      const body = await response.json();
      setTestAlertState({ status: 'done', deliveryStatus: body.deliveryStatus ?? 'unknown' });
      router.refresh();
    } catch (err) {
      setTestAlertState({ status: 'done', deliveryStatus: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const saving = saveState.status === 'saving';

  return (
    <div className="flex flex-col gap-6">
      {/* Save bar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-border bg-background/95 p-3 backdrop-blur">
        <Button type="button" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        {saveState.status === 'saved' && (
          <span className="text-sm text-emerald-400">Saved.</span>
        )}
        {saveState.status === 'error' && (
          <div className="text-sm text-red-400">
            {saveState.issues.map((issue, idx) => (
              <div key={idx}>{issue}</div>
            ))}
          </div>
        )}
      </div>

      {/* Chains enabled */}
      <Section title="Chains enabled">
        <div className="flex flex-wrap gap-6">
          {(['SOLANA', 'BSC'] as const).map((chain) => (
            <label key={chain} className="flex items-center gap-2 text-sm">
              <Switch
                checked={Boolean(getPath(settings, ['chainsEnabled', chain]))}
                onCheckedChange={(checked) => update(['chainsEnabled', chain], checked)}
              />
              {chain}
            </label>
          ))}
        </div>
      </Section>

      {/* Profitable wallet thresholds */}
      <Section title="Profitable wallet thresholds" description="Determines which wallets count as 'smart money' for flow scoring.">
        <Grid>
          <NumberField key={`v${formVersion}-pnl30d`} label="30d PnL" unit="USD" value={num(['profitableWallet', 'pnl30d'])} onChange={(v) => update(['profitableWallet', 'pnl30d'], v)} />
          <NumberField key={`v${formVersion}-minTrades`} label="Min trades" unit="trades" value={num(['profitableWallet', 'minTrades'])} onChange={(v) => update(['profitableWallet', 'minTrades'], v)} />
          <NumberField
            key={`v${formVersion}-minWinRate`}
            label="Min win rate"
            unit="%"
            displayScale={100}
            value={num(['profitableWallet', 'minWinRate'])}
            onChange={(v) => update(['profitableWallet', 'minWinRate'], v)}
          />
          <NumberField key={`v${formVersion}-minRealized`} label="Min realized PnL" unit="USD" value={num(['profitableWallet', 'minRealized'])} onChange={(v) => update(['profitableWallet', 'minRealized'], v)} />
          <NumberField
            key={`v${formVersion}-minAvgTradeSizeUsd`}
            label="Min avg trade size"
            unit="USD"
            value={num(['profitableWallet', 'minAvgTradeSizeUsd'])}
            onChange={(v) => update(['profitableWallet', 'minAvgTradeSizeUsd'], v)}
          />
        </Grid>
      </Section>

      {/* Rules A-G */}
      {RULE_ORDER.map((rule) => (
        <Section key={rule} title={`Rule ${rule} — ${RULE_FIELDS[rule].name}`}>
          <Grid>
            {RULE_FIELDS[rule].fields.map((field) => (
              <NumberField
                key={`v${formVersion}-${field.path.join('.')}`}
                label={field.label}
                unit={field.unit}
                displayScale={field.displayScale}
                value={num(field.path)}
                onChange={(v) => update(field.path, v)}
              />
            ))}
          </Grid>
        </Section>
      ))}

      {/* Graph limits */}
      <Section title="Graph limits">
        <Grid>
          <NumberField key={`v${formVersion}-maxDepth`} label="Max depth" unit="hops" value={num(['graph', 'maxDepth'])} onChange={(v) => update(['graph', 'maxDepth'], v)} />
          <NumberField key={`v${formVersion}-minTransferUsd`} label="Min transfer" unit="USD" value={num(['graph', 'minTransferUsd'])} onChange={(v) => update(['graph', 'minTransferUsd'], v)} />
          <NumberField key={`v${formVersion}-maxNodes`} label="Max nodes" unit="nodes" value={num(['graph', 'maxNodes'])} onChange={(v) => update(['graph', 'maxNodes'], v)} />
          <NumberField key={`v${formVersion}-maxEdges`} label="Max edges" unit="edges" value={num(['graph', 'maxEdges'])} onChange={(v) => update(['graph', 'maxEdges'], v)} />
          <NumberField key={`v${formVersion}-perNodeTxCap`} label="Per-node tx cap" unit="txs" value={num(['graph', 'perNodeTxCap'])} onChange={(v) => update(['graph', 'perNodeTxCap'], v)} />
        </Grid>
      </Section>

      {/* Entity confidence threshold */}
      <Section title="Entity confidence threshold" description="Minimum link-confidence score (0-100) for two wallets to be merged into one entity cluster.">
        <Grid>
          <NumberField key={`v${formVersion}-entityConfidenceThreshold`} label="Threshold" unit="/100" value={num(['entityConfidenceThreshold'])} onChange={(v) => update(['entityConfidenceThreshold'], v)} />
        </Grid>
      </Section>

      {/* Alerts */}
      <Section title="Alerts">
        <Grid>
          <NumberField key={`v${formVersion}-cooldownMin`} label="Cooldown" unit="min" value={num(['alerts', 'cooldownMin'])} onChange={(v) => update(['alerts', 'cooldownMin'], v)} />
        </Grid>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={Boolean(getPath(settings, ['alerts', 'telegramEnabled']))}
              onCheckedChange={(checked) => update(['alerts', 'telegramEnabled'], checked)}
            />
            Telegram enabled
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={Boolean(getPath(settings, ['alerts', 'discordEnabled']))}
              onCheckedChange={(checked) => update(['alerts', 'discordEnabled'], checked)}
            />
            Discord enabled
          </label>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={testAlertState.status === 'sending'} onClick={() => void handleTestAlert()}>
            {testAlertState.status === 'sending' ? 'Sending…' : 'Send test alert'}
          </Button>
          {testAlertState.status === 'done' && (
            <span className={cn('text-sm', testAlertState.deliveryStatus === 'sent' ? 'text-emerald-400' : 'text-zinc-400')}>
              {testAlertState.deliveryStatus === 'sent'
                ? 'sent'
                : testAlertState.deliveryStatus === 'skipped_no_token'
                  ? 'skipped_no_token — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env'
                  : testAlertState.deliveryStatus}
            </span>
          )}
        </div>
      </Section>

      {/* Intervals */}
      <Section title="Intervals" description="Worker job polling frequencies.">
        <Grid>
          <NumberField key={`v${formVersion}-walletActivitySec`} label="Wallet activity" unit="sec" value={num(['intervals', 'walletActivitySec'])} onChange={(v) => update(['intervals', 'walletActivitySec'], v)} />
          <NumberField key={`v${formVersion}-marketDataHotSec`} label="Market data (hot)" unit="sec" value={num(['intervals', 'marketDataHotSec'])} onChange={(v) => update(['intervals', 'marketDataHotSec'], v)} />
          <NumberField key={`v${formVersion}-marketDataNormalSec`} label="Market data (normal)" unit="sec" value={num(['intervals', 'marketDataNormalSec'])} onChange={(v) => update(['intervals', 'marketDataNormalSec'], v)} />
          <NumberField key={`v${formVersion}-flowScoringSec`} label="Flow scoring" unit="sec" value={num(['intervals', 'flowScoringSec'])} onChange={(v) => update(['intervals', 'flowScoringSec'], v)} />
          <NumberField key={`v${formVersion}-signalDetectionSec`} label="Signal detection" unit="sec" value={num(['intervals', 'signalDetectionSec'])} onChange={(v) => update(['intervals', 'signalDetectionSec'], v)} />
          <NumberField key={`v${formVersion}-alertDispatchSec`} label="Alert dispatch" unit="sec" value={num(['intervals', 'alertDispatchSec'])} onChange={(v) => update(['intervals', 'alertDispatchSec'], v)} />
          <NumberField key={`v${formVersion}-moneyFlowSec`} label="Money flow" unit="sec" value={num(['intervals', 'moneyFlowSec'])} onChange={(v) => update(['intervals', 'moneyFlowSec'], v)} />
          <NumberField key={`v${formVersion}-bridgeFlowSec`} label="Bridge flow" unit="sec" value={num(['intervals', 'bridgeFlowSec'])} onChange={(v) => update(['intervals', 'bridgeFlowSec'], v)} />
          <NumberField key={`v${formVersion}-entityClusteringSec`} label="Entity clustering" unit="sec" value={num(['intervals', 'entityClusteringSec'])} onChange={(v) => update(['intervals', 'entityClusteringSec'], v)} />
          <NumberField key={`v${formVersion}-profitRotationSec`} label="Profit rotation" unit="sec" value={num(['intervals', 'profitRotationSec'])} onChange={(v) => update(['intervals', 'profitRotationSec'], v)} />
          <NumberField key={`v${formVersion}-walletStatsRefreshHours`} label="Wallet stats refresh" unit="hours" value={num(['intervals', 'walletStatsRefreshHours'])} onChange={(v) => update(['intervals', 'walletStatsRefreshHours'], v)} />
          <NumberField key={`v${formVersion}-walletDiscoveryHours`} label="Wallet discovery" unit="hours" value={num(['intervals', 'walletDiscoveryHours'])} onChange={(v) => update(['intervals', 'walletDiscoveryHours'], v)} />
          <NumberField key={`v${formVersion}-backtestHours`} label="Backtest" unit="hours" value={num(['intervals', 'backtestHours'])} onChange={(v) => update(['intervals', 'backtestHours'], v)} />
        </Grid>
      </Section>

      {/* Provider status */}
      <Section title="Provider status" description="Reports MOCK_MODE and env-key presence — never echoes secret values.">
        <p className="text-sm text-muted-foreground">
          Address registry: {registryStats.total} entries ({registryStats.static} static, {registryStats.mock} mock)
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Chain</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providerStatuses.map((s, idx) => (
                <TableRow key={idx}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.chain}</TableCell>
                  <TableCell className="text-muted-foreground">{s.capability}</TableCell>
                  <TableCell>
                    <Badge className={MODE_BADGE_CLASS[s.mode]}>{s.mode}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.note ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Environment variables</div>
          <ul className="flex flex-col gap-1 text-sm">
            {(Object.keys(envPresence) as (keyof EnvPresence)[]).map((key) => (
              <li key={key} className="flex items-center gap-2">
                <code className="text-xs text-muted-foreground">{key}</code>
                <Badge className={envPresence[key] ? 'border-transparent bg-emerald-500/15 text-emerald-300' : 'border-transparent bg-zinc-500/15 text-zinc-400'}>
                  {envPresence[key] ? 'set' : 'missing'}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </div>
  );
}
