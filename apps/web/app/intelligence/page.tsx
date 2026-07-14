import { loadAdaptivePerformanceMetrics } from '@flowradar/db';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

function pct(value: number | null) { return value === null ? 'insufficient data' : `${(value * 100).toFixed(1)}%`; }
function number(value: number | null) { return value === null ? 'n/a' : value.toLocaleString(undefined, { maximumFractionDigits: 2 }); }

export default async function IntelligencePerformancePage() {
  const [metrics, entities, latestReplay, latestBackfill, latestLifecycle] = await Promise.all([
    loadAdaptivePerformanceMetrics(prisma),
    prisma.intelligenceEntity.findMany({ where: { status: 'active' }, select: { historicalAlphaConfidence: true, historicalAlphaScore: true, identityConfidence: true, evidenceFreshness: true } }),
    prisma.intelligenceReplayRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.intelligenceBackfillRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.intelligenceLifecycleRun.findFirst({ orderBy: { startedAt: 'desc' } })
  ]);
  const alphaReliable = entities.filter((entity) => entity.historicalAlphaConfidence >= 0.6).length;
  const scoreBuckets = Object.entries(metrics.byScoreBucket);
  const stages = Object.entries(metrics.byStage);
  const slices = metrics.analysisSlices as Record<string, unknown>;
  const byPattern = (slices.byPattern && typeof slices.byPattern === 'object' ? slices.byPattern : {}) as Record<string, { signals?: number; evaluated?: number; precision?: number | null; falsePositiveRate?: number | null }>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Adaptive Intelligence Performance</h1>
        <p className="mt-2 text-sm text-muted-foreground">Persisted entity confidence, no-lookahead outcome tracking and shadow-only feedback validation. No automatic trading or weight promotion.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric title="Signals evaluated" value={`${metrics.evaluated}/${metrics.signals}`} note={`${metrics.insufficient} insufficient`} />
        <Metric title="Precision" value={pct(metrics.precision)} note={`false positives ${pct(metrics.falsePositiveRate)}`} />
        <Metric title="Entity alpha coverage" value={`${alphaReliable}/${entities.length}`} note="sample confidence ≥60%" />
        <Metric title="No-lookahead replay" value={latestReplay?.status ?? 'not run'} note={`${latestReplay?.noLookaheadViolations ?? 0} violations`} />
      </div>

      <Section title="Funnel">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(metrics.funnel).map(([key, value]) => <Metric key={key} title={key} value={number(value)} />)}
        </div>
      </Section>

      <Section title="Calibration by score bucket">
        <Table headers={['Score', 'Signals', 'Evaluated', 'Wins', 'Precision']} rows={scoreBuckets.map(([bucket, row]) => [bucket, row.signals, row.evaluated, row.wins, pct(row.precision)])} />
      </Section>

      <Section title="Signal level performance">
        <Table headers={['Stage', 'Signals', 'Evaluated', 'Wins', 'Precision']} rows={stages.map(([stage, row]) => [stage, row.signals, row.evaluated, row.wins, pct(row.precision)])} />
      </Section>

      <Section title="Pattern performance">
        {Object.keys(byPattern).length ? (
          <Table headers={['Pattern', 'Signals', 'Evaluated', 'Precision', 'False positives']} rows={Object.entries(byPattern).map(([pattern, row]) => [pattern, row.signals ?? 0, row.evaluated ?? 0, pct(row.precision ?? null), pct(row.falsePositiveRate ?? null)])} />
        ) : <Empty />}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Entity health">
          <Table headers={['State', 'Count']} rows={Object.entries(metrics.entityHealth).map(([key, value]) => [key, value])} />
        </Section>
        <Section title="Outcome labels">
          {Object.keys(metrics.labelCounts).length ? <Table headers={['Label', 'Count']} rows={Object.entries(metrics.labelCounts)} /> : <Empty />}
        </Section>
      </div>

      <Section title="Feedback safety">
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p>Production model v{String(metrics.feedback.productionModelVersion)} · automatic weight changes: <b>{String(metrics.feedback.automaticWeightChanges)}</b></p>
          <p className="mt-2 text-muted-foreground">Candidate weights remain shadow-only unless validation and holdout precision do not regress. Latest replay: {latestReplay?.id ?? 'none'}.</p>
          <p className="mt-1 text-muted-foreground">Latest backfill: {latestBackfill ? `${latestBackfill.status} · scanned ${latestBackfill.scannedCount} · unknown ${latestBackfill.unknownCount} · errors ${latestBackfill.errorCount}` : 'none'}.</p>
        </div>
      </Section>

      <Section title="Runtime performance">
        <div className="grid gap-3 md:grid-cols-4">
          <Metric title="Lifecycle status" value={latestLifecycle?.status ?? 'not run'} note={latestLifecycle?.id ?? undefined} />
          <Metric title="Duration" value={`${metric(latestLifecycle?.metadataJson, 'durationMs')} ms`} />
          <Metric title="Throughput" value={`${metric(latestLifecycle?.metadataJson, 'throughputEventsPerSec')} events/s`} />
          <Metric title="Heap / retries" value={`${bytes(metricNumber(latestLifecycle?.metadataJson, 'heapUsedBytes'))} · ${metric(latestLifecycle?.metadataJson, 'retryCount')}`} note="heap used · DB-pass retries" />
        </div>
      </Section>
    </div>
  );
}

function Metric({ title, value, note }: { title: string; value: string; note?: string }) {
  return <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p><p className="mt-2 text-xl font-semibold">{value}</p>{note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}</div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section><h2 className="mb-3 text-lg font-semibold">{title}</h2>{children}</section>; }
function Empty() { return <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">Insufficient persisted outcome data. Nothing is inferred.</div>; }
function Table({ headers, rows }: { headers: string[]; rows: Array<Array<string | number>> }) {
  return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/40 text-xs uppercase text-muted-foreground"><tr>{headers.map((header) => <th key={header} className="px-4 py-3">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-t border-border">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-4 py-3">{cell}</td>)}</tr>)}</tbody></table></div>;
}
function metric(value: unknown, key: string) { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; return String(row[key] ?? 'n/a'); }
function metricNumber(value: unknown, key: string) { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; const number = Number(row[key]); return Number.isFinite(number) ? number : null; }
function bytes(value: number | null) { if (value === null) return 'n/a'; return `${(value / 1_048_576).toFixed(1)} MiB`; }
