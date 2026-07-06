// FlowRadar — runReplay.ts: CLI entrypoint for runHistoricalReplay (Task 41
// binding decision 5).
//
// `npm run backtest:replay` (workspace) / root forwarder. Defaults to
// replaying the trailing 72h (matches seed.ts's own WORLD_HORIZON_HOURS mock
// period) unless FROM/TO env vars are supplied. Prints:
//   - replayed signal count
//   - rule-performance table (real vs synthetic-evidence split, per rule A-G)
//   - top-3 / bottom-3 threshold sets from the OAT sweep
//   - walk-forward verdict
//   - the MANDATORY overfitting warning
//   - the documented scope limitations (wallet/cluster current-state,
//     tuning/walk-forward single-token scope)

import { prisma } from '../client';
import { runHistoricalReplay } from '../replayRunner';
import type { RulePerformance, ThresholdSet } from '@flowradar/core';

const HOUR_MS = 60 * 60_000;

function parseEnvDate(name: string, fallback: Date): Date {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${name} env var: '${raw}' is not a parseable date.`);
  }
  return parsed;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printRulePerformanceTable(perf: RulePerformance): void {
  console.log('\n=== Rule Performance (real vs synthetic-evidence, NEVER pooled) ===');
  console.log(
    ['Rule', 'Real N', 'Real hit2x', 'Real hit5x', 'Synth N', 'Synth hit2x', 'Synth hit5x']
      .map((h) => h.padEnd(12))
      .join('')
  );
  for (const rule of ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const) {
    const s = perf[rule];
    console.log(
      [
        rule,
        String(s.real.signalCount),
        fmtPct(s.real.hitRate2x),
        fmtPct(s.real.hitRate5x),
        String(s.synthetic.signalCount),
        fmtPct(s.synthetic.hitRate2x),
        fmtPct(s.synthetic.hitRate5x)
      ]
        .map((c) => c.padEnd(12))
        .join('')
    );
  }
}

function printThresholdSets(label: string, sets: ThresholdSet[]): void {
  console.log(`\n=== ${label} ===`);
  for (const s of sets) {
    console.log(
      `  dimension=${s.dimension} value=${s.value} signalCount=${s.signalCount} hitRate2x=${fmtPct(s.hitRate2x)} score=${s.score.toFixed(3)}${s.insufficientSample ? ' [INSUFFICIENT SAMPLE]' : ''}`
    );
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 72 * HOUR_MS);
  const from = parseEnvDate('REPLAY_FROM', defaultFrom);
  const to = parseEnvDate('REPLAY_TO', now);

  console.log(`[backtest:replay] Running historical replay from ${from.toISOString()} to ${to.toISOString()}...`);

  const { backtestRunId, summary } = await runHistoricalReplay(prisma, { from, to });

  console.log(`\n[backtest:replay] BacktestRun persisted: ${backtestRunId}`);
  console.log(`[backtest:replay] Replayed signal count: ${summary.replayedSignalCount}`);
  console.log(`[backtest:replay] Synthetic evidence present: ${summary.syntheticEvidencePresent}`);

  printRulePerformanceTable(summary.rulePerformance);

  console.log('\n=== Combined Strategy Performance ===');
  for (const combo of summary.comboPerformance) {
    console.log(
      `  ${combo.name}: real N=${combo.summary.real.signalCount} hit2x=${fmtPct(combo.summary.real.hitRate2x)} | synthetic N=${combo.summary.synthetic.signalCount} hit2x=${fmtPct(combo.summary.synthetic.hitRate2x)}`
    );
  }

  printThresholdSets('Top-3 threshold sets', summary.thresholdTuning.best);
  printThresholdSets('Bottom-3 threshold sets', summary.thresholdTuning.worst);

  console.log('\n=== Recommended Defaults (diff vs current DEFAULT_SETTINGS) ===');
  console.log(JSON.stringify(summary.thresholdTuning.recommendedDefaults.diff, null, 2));

  console.log('\n=== Walk-Forward Validation ===');
  console.log(`  Verdict: ${summary.walkForward.verdict}`);
  console.log(`  Degradation: ${summary.walkForward.degradationPct.toFixed(1)}%`);
  console.log(
    `  Tune half: N=${summary.walkForward.tuneSummary.signalCount} hit2x=${fmtPct(summary.walkForward.tuneSummary.hitRate2x)}`
  );
  console.log(
    `  Test half: N=${summary.walkForward.testSummary.signalCount} hit2x=${fmtPct(summary.walkForward.testSummary.hitRate2x)}`
  );

  console.log('\n=== OVERFITTING WARNING (mandatory) ===');
  console.log(summary.thresholdTuning.overfittingWarning);

  console.log('\n=== Scope Limitations ===');
  for (const limitation of summary.limitations) {
    console.log(`  - ${limitation}`);
  }

  console.log('\n[backtest:replay] done.');
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error('[backtest:replay] fatal error:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
