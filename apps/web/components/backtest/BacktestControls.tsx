'use client';

// FlowRadar — /backtest page controls (Task 42 binding decision 3).
//
// "Run replay" POSTs /api/backtest/replay with a small bounded window (last
// 24h — well inside the 14-day server-side cap — so a click from the UI
// completes in a reasonable request lifetime instead of a caller having to
// hand-pick from/to). "Evaluate now" POSTs /api/backtest/evaluate with no
// body. Both show a busy state on their own button and a result banner
// below (no toast library exists in this app — see SettingsForm's own
// saveState/testAlertState pattern, which this mirrors), then
// router.refresh() so the server-rendered summary/rule tables reflect the
// just-created BacktestRun / just-upserted BacktestResult rows.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type RunState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; message: string; ok: true }
  | { status: 'done'; message: string; ok: false };

const REPLAY_WINDOW_HOURS = 24;

export function BacktestControls() {
  const router = useRouter();
  const [replayState, setReplayState] = useState<RunState>({ status: 'idle' });
  const [evaluateState, setEvaluateState] = useState<RunState>({ status: 'idle' });

  async function handleRunReplay(): Promise<void> {
    setReplayState({ status: 'busy' });
    try {
      const to = new Date();
      const from = new Date(to.getTime() - REPLAY_WINDOW_HOURS * 60 * 60 * 1000);
      const response = await fetch('/api/backtest/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from.toISOString(), to: to.toISOString() })
      });
      const body = await response.json();
      if (!response.ok) {
        const issues: string[] = Array.isArray(body.issues)
          ? body.issues.map((i: { path: string; message: string }) => (i.path ? `${i.path}: ${i.message}` : i.message))
          : [body.error ?? `replay failed (HTTP ${response.status})`];
        setReplayState({ status: 'done', ok: false, message: issues.join('; ') });
        return;
      }
      setReplayState({ status: 'done', ok: true, message: `Replay run ${body.runId} complete.` });
      router.refresh();
    } catch (err) {
      setReplayState({ status: 'done', ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleEvaluateNow(): Promise<void> {
    setEvaluateState({ status: 'busy' });
    try {
      const response = await fetch('/api/backtest/evaluate', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setEvaluateState({ status: 'done', ok: false, message: body.error ?? `evaluate failed (HTTP ${response.status})` });
        return;
      }
      setEvaluateState({
        status: 'done',
        ok: true,
        message: `Evaluated ${body.signalsEvaluated} signal(s), upserted ${body.rowsUpserted} row(s).`
      });
      router.refresh();
    } catch (err) {
      setEvaluateState({ status: 'done', ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const replayBusy = replayState.status === 'busy';
  const evaluateBusy = evaluateState.status === 'busy';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={replayBusy} onClick={() => void handleRunReplay()}>
          {replayBusy ? 'Running replay…' : `Run replay (last ${REPLAY_WINDOW_HOURS}h)`}
        </Button>
        <Button type="button" variant="outline" disabled={evaluateBusy} onClick={() => void handleEvaluateNow()}>
          {evaluateBusy ? 'Evaluating…' : 'Evaluate now'}
        </Button>
      </div>
      {replayState.status === 'done' && (
        <p className={cn('text-sm', replayState.ok ? 'text-emerald-400' : 'text-red-400')}>{replayState.message}</p>
      )}
      {evaluateState.status === 'done' && (
        <p className={cn('text-sm', evaluateState.ok ? 'text-emerald-400' : 'text-red-400')}>{evaluateState.message}</p>
      )}
    </div>
  );
}
