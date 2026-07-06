// FlowRadar — /backtest summary view (Task 42 binding decision 3).
//
// Pure presentational component over the LATEST BacktestRun's already-shaped
// summary (packages/db/src/replayRunner.ts's BacktestRunSummary, Decimal-free
// per this app's serialization-boundary convention — the page itself does
// the Json -> typed conversion). Every section listed in the binding
// decision is rendered unconditionally when data exists; the real vs
// synthetic-evidence split is ALWAYS shown side by side (never silently
// pooled — mirrors rulePerf.ts's own hard requirement), with the synthetic
// column visually de-emphasized (dimmed text, badge) rather than hidden.

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtPct } from '@/lib/format';

export interface OutcomesSummaryView {
  signalCount: number;
  hitRatePlus50: number;
  hitRate2x: number;
  hitRate5x: number;
  hitRate10x: number;
  medianReturnPct: number | null;
  avgReturnPct: number | null;
  failureRate: number;
  hardFailureRate: number;
}

export interface RealSyntheticSplitView {
  real: OutcomesSummaryView;
  synthetic: OutcomesSummaryView;
}

export type RulePerformanceView = Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', RealSyntheticSplitView>;

export interface ComboPerfView {
  name: string;
  summary: RealSyntheticSplitView;
}

export interface BucketBreakdownsView {
  mcapAtTrigger: Record<string, RealSyntheticSplitView>;
  liquidity: Record<string, RealSyntheticSplitView>;
  uniqueEntityCount: Record<string, RealSyntheticSplitView>;
  clusterConcentration: Record<string, RealSyntheticSplitView>;
}

export interface ThresholdSetView {
  dimension: string;
  value: number;
  signalCount: number;
  hitRate2x: number;
  score: number;
  insufficientSample: boolean;
}

export interface ThresholdTuningView {
  best: ThresholdSetView[];
  worst: ThresholdSetView[];
  recommendedDefaults: { diff: Record<string, { from: unknown; to: unknown }> };
  overfittingWarning: string;
}

export interface WalkForwardView {
  verdict: string;
  degradationPct: number;
  tuneSummary: { signalCount: number; hitRate2x: number };
  testSummary: { signalCount: number; hitRate2x: number };
}

export interface BacktestRunView {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  periodFrom: Date;
  periodTo: Date;
  syntheticEvidence: boolean;
  replayedSignalCount: number;
  rulePerformance: RulePerformanceView;
  comboPerformance: ComboPerfView[];
  bucketPerformance: BucketBreakdownsView;
  thresholdTuning: ThresholdTuningView;
  walkForward: WalkForwardView;
  limitations: string[];
}

const RULE_NAME: Record<string, string> = {
  A: 'Coordinated Accumulation',
  B: 'Slow Accumulation',
  C: 'Organic Distribution',
  D: 'Whale Entry',
  E: 'Funded Fresh Wallets',
  F: 'Profit Rotation',
  G: 'Smart Money Exit'
};

function fmtDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function RealSyntheticCell({ summary, emphasis }: { summary: OutcomesSummaryView; emphasis: 'real' | 'synthetic' }) {
  return (
    <div className={emphasis === 'synthetic' ? 'opacity-60' : ''}>
      <div className="tabular-nums">
        N={summary.signalCount} · 2x={fmtPct(summary.hitRate2x * 100)}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        5x={fmtPct(summary.hitRate5x * 100)} · fail={fmtPct(summary.failureRate * 100)}
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RulePerformanceTable({ perf }: { perf: RulePerformanceView }) {
  const rules = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Real signals</TableHead>
            <TableHead>
              Synthetic-evidence signals <Badge className="ml-1 border-transparent bg-violet-500/15 text-violet-300">synthetic demo data</Badge>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule}>
              <TableCell className="font-medium">
                {rule} <span className="text-xs text-muted-foreground">— {RULE_NAME[rule]}</span>
              </TableCell>
              <TableCell>
                <RealSyntheticCell summary={perf[rule].real} emphasis="real" />
              </TableCell>
              <TableCell>
                <RealSyntheticCell summary={perf[rule].synthetic} emphasis="synthetic" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ComboPerformanceTable({ combos }: { combos: ComboPerfView[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Combo</TableHead>
            <TableHead>Real</TableHead>
            <TableHead>Synthetic</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {combos.map((combo) => (
            <TableRow key={combo.name}>
              <TableCell className="font-medium">{combo.name}</TableCell>
              <TableCell>
                <RealSyntheticCell summary={combo.summary.real} emphasis="real" />
              </TableCell>
              <TableCell>
                <RealSyntheticCell summary={combo.summary.synthetic} emphasis="synthetic" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BucketTable({ title, buckets }: { title: string; buckets: Record<string, RealSyntheticSplitView> }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead>Real</TableHead>
              <TableHead>Synthetic</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(buckets).map(([key, split]) => (
              <TableRow key={key}>
                <TableCell className="font-medium">{key}</TableCell>
                <TableCell>
                  <RealSyntheticCell summary={split.real} emphasis="real" />
                </TableCell>
                <TableCell>
                  <RealSyntheticCell summary={split.synthetic} emphasis="synthetic" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ThresholdSetTable({ title, sets }: { title: string; sets: ThresholdSetView[] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
      {sets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No candidate sets.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dimension</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>N</TableHead>
                <TableHead>Hit 2x</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Sample</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sets.map((s, idx) => (
                <TableRow key={idx}>
                  <TableCell className="font-medium">{s.dimension}</TableCell>
                  <TableCell className="tabular-nums">{s.value}</TableCell>
                  <TableCell className="tabular-nums">{s.signalCount}</TableCell>
                  <TableCell className="tabular-nums">{fmtPct(s.hitRate2x * 100)}</TableCell>
                  <TableCell className="tabular-nums">{s.score.toFixed(3)}</TableCell>
                  <TableCell>
                    {s.insufficientSample ? (
                      <Badge className="border-transparent bg-amber-500/15 text-amber-400">insufficient sample</Badge>
                    ) : (
                      <Badge className="border-transparent bg-emerald-500/15 text-emerald-300">sufficient</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function BacktestSummaryView({ run }: { run: BacktestRunView }) {
  const diffEntries = Object.entries(run.thresholdTuning.recommendedDefaults.diff);

  return (
    <div className="flex flex-col gap-6">
      <Section title="Run status">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Period</div>
            <div className="font-medium">
              {fmtDate(run.periodFrom)} → {fmtDate(run.periodTo)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Started</div>
            <div className="font-medium">{fmtDate(run.startedAt)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Status</div>
            <Badge
              className={
                run.status === 'complete'
                  ? 'border-transparent bg-emerald-500/15 text-emerald-300'
                  : run.status === 'failed'
                    ? 'border-transparent bg-red-500/15 text-red-400'
                    : 'border-transparent bg-zinc-500/15 text-zinc-300'
              }
            >
              {run.status}
            </Badge>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Replayed signals</div>
            <div className="font-medium tabular-nums">{run.replayedSignalCount}</div>
          </div>
          {run.syntheticEvidence && (
            <Badge className="border-transparent bg-violet-500/15 text-violet-300">
              synthetic evidence present in this run
            </Badge>
          )}
        </div>
      </Section>

      <Section
        title="Rule performance"
        description="Real vs synthetic-evidence outcomes, per rule (A–G). Never pooled — synthetic-evidence signals only ever proved the code path ran, not that the rule has edge."
      >
        <RulePerformanceTable perf={run.rulePerformance} />
      </Section>

      <Section title="Combined strategy performance" description="A / A+B / A+C / A+entity-adjusted / A+low-sell-pressure / F / F+cluster-confidence / A∪B∪F.">
        <ComboPerformanceTable combos={run.comboPerformance} />
      </Section>

      <Section title="Performance by bucket" description="Four independent bucketing dimensions over the same replayed batch.">
        <div className="flex flex-col gap-6">
          <BucketTable title="Mcap at trigger" buckets={run.bucketPerformance.mcapAtTrigger} />
          <BucketTable title="Liquidity at trigger" buckets={run.bucketPerformance.liquidity} />
          <BucketTable title="Unique entity count" buckets={run.bucketPerformance.uniqueEntityCount} />
          <BucketTable title="Cluster concentration" buckets={run.bucketPerformance.clusterConcentration} />
        </div>
      </Section>

      <Section
        title="Threshold comparison"
        description="One-at-a-time (OAT) sweep over the tuning grid, scored by hitRate2x among Rule A/F signals."
      >
        <div className="flex flex-col gap-6">
          <ThresholdSetTable title="Top-3 threshold sets" sets={run.thresholdTuning.best} />
          <ThresholdSetTable title="Bottom-3 threshold sets" sets={run.thresholdTuning.worst} />
        </div>
      </Section>

      <Section title="Recommended defaults" description="Diff of the best-scoring threshold set vs current Settings.">
        {diffEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No change recommended — the current settings already match the best-scoring set (or no set outperformed it).</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {diffEntries.map(([path, change]) => (
              <li key={path} className="flex items-center gap-2">
                <code className="text-xs text-muted-foreground">{path}</code>
                <span className="tabular-nums">{String(change.from)}</span>
                <span aria-hidden="true">→</span>
                <span className="font-medium tabular-nums text-emerald-400">{String(change.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Walk-forward validation" description="Tuned on the first half of the period, tested on the second — never tuned and tested on the same sample.">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Badge
            className={
              run.walkForward.verdict === 'holds up'
                ? 'border-transparent bg-emerald-500/15 text-emerald-300'
                : 'border-transparent bg-red-500/15 text-red-400'
            }
          >
            {run.walkForward.verdict}
          </Badge>
          <div>
            <div className="text-xs text-muted-foreground">Degradation</div>
            <div className="font-medium tabular-nums">{run.walkForward.degradationPct.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Tune half</div>
            <div className="font-medium tabular-nums">
              N={run.walkForward.tuneSummary.signalCount} · hit2x={fmtPct(run.walkForward.tuneSummary.hitRate2x * 100)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Test half</div>
            <div className="font-medium tabular-nums">
              N={run.walkForward.testSummary.signalCount} · hit2x={fmtPct(run.walkForward.testSummary.hitRate2x * 100)}
            </div>
          </div>
        </div>
      </Section>

      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        <span className="font-medium text-red-300">Overfitting warning: </span>
        {run.thresholdTuning.overfittingWarning}
      </div>

      <Section title="Scope limitations">
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          {run.limitations.map((limitation, idx) => (
            <li key={idx}>{limitation}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
