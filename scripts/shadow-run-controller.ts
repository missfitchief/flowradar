// FlowRadar — supervised, resumable SHADOW-RUN controller (Priority 7, rev 2).
//
// Runs the normal worker (normal speeds — never WORKER_FAST) as a TRACKED
// child process with a persistent run record:
//   start [--days N] [--resume <runId>]   create/resume, spawn worker,
//                                         supervise (heartbeat 15 min, daily
//                                         checkpoints, honest end-of-target)
//   status                                run + controller + worker liveness,
//                                         detects and WARNS on orphans
//   stop                                  signals the CONTROLLER via a STOP
//                                         sentinel (clean shutdown incl. the
//                                         worker); falls back to direct
//                                         graceful-then-forced worker kill +
//                                         verification when no controller is
//                                         alive; never reports success it
//                                         didn't verify
//   report                                read-only shadow outcomes with
//                                         coverage gates (see below)
//
// ORPHAN-SAFETY GUARANTEES (exact, not absolute): the supervision loop kills
// the worker on ANY controller error (try/finally + uncaught handlers), on
// SIGINT/SIGTERM, at the end target, and on the STOP sentinel (checked every
// 30s). RESIDUAL RISK, stated honestly: a hard controller kill (SIGKILL /
// power loss) on Windows does NOT auto-kill a child process — `status` then
// detects the orphan (run 'running', controller pid dead, worker pid alive)
// and prints the exact taskkill command. PID-reuse risk is mitigated by
// verifying the pid's image name is node before killing.
//
// ANALYTICS ONLY: no execution; provider budget = the worker's own caps,
// printed with an ITEMIZED projection (first-cycle backfill + steady state +
// other Helius consumers named). State in gitignored runs/<runId>/.
// Usage: npx tsx scripts/shadow-run-controller.ts <start|status|stop|report> [...]
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../packages/db/src/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'runs');
mkdirSync(RUNS_DIR, { recursive: true });
const HEARTBEAT_MIN = 15;
const SENTINEL_POLL_SEC = 30;
const ACTIVE_FILE = path.join(RUNS_DIR, 'ACTIVE');

interface RunState {
  runId: string;
  startedAt: string;
  endTargetAt: string;
  controllerPid: number | null;
  workerPid: number | null;
  status: 'running' | 'stopped' | 'completed' | 'stop-failed';
  env: { walletBudget: string; heliusRps: string };
  baseline: Record<string, number>;
  /** sha256 of the sorted signal_eligible wallet-id list at baseline — the
   *  trust invariant compares MEMBERSHIP, not just a count. */
  baselineEligibleDigest: string;
  lastHeartbeatAt?: string;
  stoppedAt?: string;
  notes: string[];
}

const stopSentinel = (runId: string) => path.join(RUNS_DIR, runId, 'STOP');
function statePath(runId: string): string { return path.join(RUNS_DIR, runId, 'state.json'); }
function loadState(runId: string): RunState { return JSON.parse(readFileSync(statePath(runId), 'utf-8')) as RunState; }
function saveState(s: RunState): void { writeFileSync(statePath(s.runId), JSON.stringify(s, null, 2)); }
function activeRunId(): string | null { return existsSync(ACTIVE_FILE) ? readFileSync(ACTIVE_FILE, 'utf-8').trim() || null : null; }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pidIsNode(pid: number): boolean {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' });
    return /node/i.test(out);
  } catch { return false; }
}
function workerRssMb(pid: number): number | null {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' });
    const m = out.match(/"([\d,.]+) K"/);
    return m ? Math.round(Number(m[1]!.replace(/[,.]/g, '')) / 1024) : null;
  } catch { return null; }
}

/** Graceful-then-forced kill with VERIFICATION. Returns true only when the
 *  process is verifiably gone. Refuses to kill a pid whose image is not node
 *  (pid-reuse guard). */
async function killWorkerVerified(pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  if (!pidIsNode(pid)) return false; // pid reused by another program — do NOT kill
  try { execSync(`taskkill /PID ${pid} /T`, { stdio: 'ignore' }); } catch { /* may need force */ }
  await new Promise((r) => setTimeout(r, 5000));
  if (!pidAlive(pid)) return true;
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* verified below */ }
  await new Promise((r) => setTimeout(r, 2000));
  return !pidAlive(pid);
}

async function eligibleDigest(): Promise<string> {
  const ids = (await prisma.wallet.findMany({ where: { status: 'signal_eligible' }, select: { id: true }, orderBy: { id: 'asc' } })).map((w) => w.id);
  return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16) + `:${ids.length}`;
}

async function census(): Promise<Record<string, number>> {
  return {
    wallets: await prisma.wallet.count(),
    eligible: await prisma.wallet.count({ where: { status: 'signal_eligible' } }),
    observation: await prisma.wallet.count({ where: { status: 'observation_only' } }),
    edges: await prisma.moneyFlowEdge.count(),
    relationships: await prisma.walletRelationship.count(),
    hotReceivers: await prisma.monitoringSubscription.count({ where: { priority: 'fresh_receiver_hot', active: true } }),
    tokens: await prisma.token.count(),
    trades: await prisma.walletTokenTrade.count(),
    marketSnapshots: await prisma.tokenMarketSnapshot.count(),
    stealthSnapshots: await prisma.stealthSnapshot.count(),
    stealthNonWatching: await prisma.stealthSnapshot.count({ where: { state: { not: 'WATCHING' } } }),
    kolArrivals: await prisma.stealthSnapshot.count({ where: { state: { in: ['PUBLIC_KOL_ARRIVAL', 'CROWD_EXPANSION'] } } }),
    providerErrors: await prisma.providerSyncState.count({ where: { failCount: { gt: 0 } } }),
    signals: await prisma.signal.count(),
    walletStats: await prisma.walletStats.count()
  };
}

async function heartbeat(s: RunState): Promise<void> {
  const c = await census();
  const digest = await eligibleDigest();
  const hb = {
    ts: new Date().toISOString(),
    workerAlive: s.workerPid !== null && pidAlive(s.workerPid),
    workerRssMb: s.workerPid !== null ? workerRssMb(s.workerPid) : null,
    census: c,
    delta: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v - (s.baseline[k] ?? 0)])),
    // MEMBERSHIP digest, not a count: equal add/remove churn cannot hide.
    // NOTE: legitimate candidate promotion also changes it — a change means
    // INVESTIGATE (diff the ids), not automatically a breach.
    trustInvariant: digest === s.baselineEligibleDigest ? 'HOLDS' : `ELIGIBLE MEMBERSHIP CHANGED (${s.baselineEligibleDigest} -> ${digest}) — investigate: promotion is legitimate, shadow paths are not`
  };
  appendFileSync(path.join(RUNS_DIR, s.runId, 'heartbeats.jsonl'), JSON.stringify(hb) + '\n');
  s.lastHeartbeatAt = hb.ts;
  saveState(s);
  console.log(JSON.stringify({ heartbeat: hb.ts, workerAlive: hb.workerAlive, rssMb: hb.workerRssMb, trustInvariant: hb.trustInvariant, stealthSnapshots: c.stealthSnapshots }));
}

async function checkpoint(s: RunState, label: string): Promise<void> {
  const c = await census();
  writeFileSync(
    path.join(RUNS_DIR, s.runId, `checkpoint-${label}.json`),
    JSON.stringify({ ts: new Date().toISOString(), label, census: c, baseline: s.baseline }, null, 2)
  );
}

function spawnWorker(s: RunState, log: string): number | null {
  const child = spawn('npx', ['tsx', 'apps/worker/src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_MODE: 'false', WALLET_ACTIVITY_MAX_WALLETS: s.env.walletBudget, HELIUS_RPS: s.env.heliusRps, WORKER_FAST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: false
  });
  child.stdout.on('data', (d: Buffer) => appendFileSync(log, d));
  child.stderr.on('data', (d: Buffer) => appendFileSync(log, d));
  return child.pid ?? null;
}

async function start(): Promise<void> {
  const resumeIdx = process.argv.indexOf('--resume');
  const daysIdx = process.argv.indexOf('--days');
  const days = daysIdx > -1 ? Math.max(1, Math.min(14, Number(process.argv[daysIdx + 1]) || 7)) : 7;

  // Duplicate-run guard applies to BOTH fresh starts and --resume: a live
  // CONTROLLER (which may be about to restart a temporarily-dead worker) or
  // a live worker on the active run blocks a second start (Codex C#3).
  const existing = activeRunId();
  if (existing) {
    const st = loadState(existing);
    const controllerLive = st.controllerPid !== null && pidAlive(st.controllerPid);
    const workerLive = st.workerPid !== null && pidAlive(st.workerPid);
    if (st.status === 'running' && (controllerLive || workerLive)) {
      throw new Error(`run ${existing} is ACTIVE (controller ${controllerLive ? 'alive' : 'dead'}, worker ${workerLive ? 'alive' : 'dead'}) — use status/stop; never two runs`);
    }
  }

  let s: RunState;
  if (resumeIdx > -1) {
    s = loadState(String(process.argv[resumeIdx + 1]));
    if (s.workerPid !== null && pidAlive(s.workerPid)) throw new Error(`run ${s.runId} already has a live worker (pid ${s.workerPid})`);
    if (s.controllerPid !== null && pidAlive(s.controllerPid)) throw new Error(`run ${s.runId} already has a live controller (pid ${s.controllerPid})`);
    s.notes.push(`resumed at ${new Date().toISOString()}`);
    s.status = 'running';
  } else {
    const runId = `shadow-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
    s = {
      runId,
      startedAt: new Date().toISOString(),
      endTargetAt: new Date(Date.now() + days * 86400_000).toISOString(),
      controllerPid: process.pid,
      workerPid: null,
      status: 'running',
      env: {
        walletBudget: process.env.WALLET_ACTIVITY_MAX_WALLETS ?? '50',
        heliusRps: process.env.HELIUS_RPS ?? '5'
      },
      baseline: await census(),
      baselineEligibleDigest: await eligibleDigest(),
      notes: []
    };
    saveState(s);
    await checkpoint(s, 'start');
  }
  s.controllerPid = process.pid;
  if (existsSync(stopSentinel(s.runId))) rmSync(stopSentinel(s.runId));
  writeFileSync(ACTIVE_FILE, s.runId);

  // ITEMIZED provider projection (Codex C#8): cadence read from the stored
  // settings row (not hardcoded), first-cycle backfill itemized, other
  // consumers NAMED (they share the same rate limiter but add volume).
  const budget = Number(s.env.walletBudget);
  const settingsRow = await prisma.settings.findFirst();
  const cadenceSec = Number((settingsRow?.values as { intervals?: { walletActivitySec?: number } })?.intervals?.walletActivitySec ?? 45);
  const steadyDaily = Math.round(budget * (86400 / cadenceSec));
  console.log(JSON.stringify({
    runId: s.runId, endTargetAt: s.endTargetAt, controllerPid: process.pid,
    providerProjection: {
      walletActivityMaxWallets: budget,
      heliusRps: Number(s.env.heliusRps),
      walletActivityCadenceSec: cadenceSec,
      steadyStateRequestsPerDay: steadyDaily,
      firstCycleBackfillExtra: `up to ${budget * 4} additional page requests in the first coverage rotation (5 pages/wallet vs 1)`,
      alsoConsumingHelius: 'lineageExpansion + monitoringScheduler reopens + flowScoring risk checks (shared rate limiter, additional volume not in the above number)'
    },
    note: 'normal worker speeds; WORKER_FAST blank; stop anytime: shadow-run-controller stop'
  }, null, 2));

  const log = path.join(RUNS_DIR, s.runId, 'worker.log');
  s.workerPid = spawnWorker(s, log);
  saveState(s);
  console.log(JSON.stringify({ workerStarted: true, pid: s.workerPid, log }));

  let lastCheckpointDay = new Date().toISOString().slice(0, 10);
  let finished = false;
  const shutdown = async (reason: string) => {
    if (finished) return;
    finished = true;
    console.log(JSON.stringify({ shuttingDown: reason }));
    const killed = s.workerPid === null ? true : await killWorkerVerified(s.workerPid);
    s.status = reason === 'end-target-reached' ? 'completed' : killed ? 'stopped' : 'stop-failed';
    if (!killed) s.notes.push(`WORKER KILL UNVERIFIED (pid ${s.workerPid}) — kill manually: taskkill /PID ${s.workerPid} /T /F`);
    s.stoppedAt = new Date().toISOString();
    saveState(s);
    await checkpoint(s, `final-${reason}`);
    writeFileSync(ACTIVE_FILE, '');
    await prisma.$disconnect();
    process.exit(killed ? 0 : 1);
  };
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));
  process.on('uncaughtException', (e) => { console.error('controller uncaught:', e); void shutdown('controller-error'); });
  process.on('unhandledRejection', (e) => { console.error('controller rejection:', e); void shutdown('controller-error'); });

  // Supervision loop inside try/finally: ANY escape kills the worker.
  try {
    let sinceHeartbeatSec = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, SENTINEL_POLL_SEC * 1000));
      sinceHeartbeatSec += SENTINEL_POLL_SEC;
      // STOP sentinel — the `stop` command's clean-shutdown channel.
      if (existsSync(stopSentinel(s.runId))) { await shutdown('manual-stop'); return; }
      if (new Date() >= new Date(s.endTargetAt)) { await shutdown('end-target-reached'); return; }
      if (sinceHeartbeatSec >= HEARTBEAT_MIN * 60) {
        sinceHeartbeatSec = 0;
        await heartbeat(s);
        const day = new Date().toISOString().slice(0, 10);
        if (day !== lastCheckpointDay) { await checkpoint(s, day); lastCheckpointDay = day; }
        if (s.workerPid !== null && !pidAlive(s.workerPid)) {
          s.notes.push(`worker died, restarting at ${new Date().toISOString()}`);
          s.workerPid = spawnWorker(s, log);
          saveState(s);
        }
      }
    }
  } finally {
    if (!finished) await shutdown('controller-loop-exit');
  }
}

async function status(): Promise<void> {
  const id = activeRunId();
  if (!id) { console.log(JSON.stringify({ activeRun: null })); await prisma.$disconnect(); return; }
  const s = loadState(id);
  const controllerAlive = s.controllerPid !== null && pidAlive(s.controllerPid);
  const workerAlive = s.workerPid !== null && pidAlive(s.workerPid);
  const orphaned = s.status === 'running' && !controllerAlive && workerAlive;
  console.log(JSON.stringify({
    runId: s.runId, status: s.status, startedAt: s.startedAt, endTargetAt: s.endTargetAt,
    controllerPid: s.controllerPid, controllerAlive,
    workerPid: s.workerPid, workerAlive,
    ...(orphaned ? { ORPHAN_WARNING: `worker pid ${s.workerPid} is running WITHOUT its controller — kill: taskkill /PID ${s.workerPid} /T /F, or resume: shadow-run-controller start --resume ${s.runId}` } : {}),
    lastHeartbeatAt: s.lastHeartbeatAt ?? null, notes: s.notes.slice(-3)
  }, null, 2));
  await prisma.$disconnect();
}

async function stop(): Promise<void> {
  const id = activeRunId();
  if (!id) { console.log('no active run'); await prisma.$disconnect(); return; }
  const s = loadState(id);
  const controllerAlive = s.controllerPid !== null && pidAlive(s.controllerPid);
  if (controllerAlive) {
    // Clean channel: the CONTROLLER owns shutdown (kills worker, checkpoints,
    // clears ACTIVE). We wait for it to acknowledge — never report success
    // we didn't observe (Codex C#1/#4).
    writeFileSync(stopSentinel(id), new Date().toISOString());
    for (let i = 0; i < 12; i++) { // up to ~2 min (sentinel poll is 30s)
      await new Promise((r) => setTimeout(r, 10_000));
      const cur = loadState(id);
      if (cur.status !== 'running') {
        console.log(JSON.stringify({ stopped: id, via: 'controller', finalStatus: cur.status }));
        await prisma.$disconnect();
        return;
      }
    }
    console.log(JSON.stringify({ stopRequested: id, warning: 'controller did not acknowledge within 2min — check status; worker may still be supervised' }));
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }
  // No controller: kill the worker directly, VERIFIED.
  const killed = s.workerPid === null ? true : await killWorkerVerified(s.workerPid);
  s.status = killed ? 'stopped' : 'stop-failed';
  if (!killed) s.notes.push(`WORKER KILL UNVERIFIED (pid ${s.workerPid})`);
  s.stoppedAt = new Date().toISOString();
  saveState(s);
  await checkpoint(s, 'final-manual-stop');
  writeFileSync(ACTIVE_FILE, '');
  console.log(JSON.stringify({ stopped: id, via: 'direct-kill', verified: killed }));
  await prisma.$disconnect();
  if (!killed) process.exitCode = 1;
}

/** Shadow outcomes, read-only, with COVERAGE GATES (Codex C#5/#6):
 *  - baseline must be a REAL (non-synthetic) snapshot within 1h before signal
 *  - a horizon is reported only when wall-clock elapsed AND a non-synthetic
 *    snapshot exists at/after the horizon end (coverage proven)
 *  - drawdown = true peak-to-later-trough over the ordered window. */
async function report(): Promise<void> {
  const firstSignals = await prisma.stealthSnapshot.groupBy({
    by: ['tokenId'],
    where: { state: { not: 'WATCHING' } },
    _min: { computedAt: true },
    orderBy: { _min: { computedAt: 'asc' } },
    take: 100 // DB-bounded (Codex C#9)
  });
  const notSynthetic = { source: { not: 'seed_synthetic_continuation' } };
  const out: Record<string, unknown>[] = [];
  for (const sig of firstSignals) {
    const t0 = sig._min.computedAt!;
    const base = await prisma.tokenMarketSnapshot.findFirst({
      where: { tokenId: sig.tokenId, ts: { lte: t0, gte: new Date(t0.getTime() - 3600_000) }, ...notSynthetic },
      orderBy: { ts: 'desc' },
      select: { marketCapUsd: true }
    });
    const row: Record<string, unknown> = { tokenId: sig.tokenId, signalAt: t0.toISOString(), baseMcap: base ? Number(base.marketCapUsd) : null };
    if (!base || Number(base.marketCapUsd) <= 0) {
      row.outcomes = 'no fresh real baseline snapshot (within 1h before signal) — not reported';
      out.push(row);
      continue;
    }
    const baseMcap = Number(base.marketCapUsd);
    for (const [label, hours] of [['h1', 1], ['h6', 6], ['h24', 24], ['h72', 72]] as const) {
      const end = new Date(t0.getTime() + hours * 3600_000);
      if (end > new Date()) { row[label] = 'not yet elapsed'; continue; }
      const covered = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId: sig.tokenId, ts: { gte: end }, ...notSynthetic }, select: { id: true }
      });
      if (!covered) { row[label] = 'elapsed but snapshot coverage incomplete — not reported'; continue; }
      const pts = await prisma.tokenMarketSnapshot.findMany({
        where: { tokenId: sig.tokenId, ts: { gt: t0, lte: end }, marketCapUsd: { gt: 0 }, ...notSynthetic },
        orderBy: { ts: 'asc' },
        select: { marketCapUsd: true }
      });
      if (pts.length === 0) { row[label] = 'no in-window snapshots — not reported'; continue; }
      let peak = baseMcap;
      let maxUpside = 0;
      let maxDrawdown = 0;
      for (const p of pts) {
        const v = Number(p.marketCapUsd);
        if (v > peak) peak = v;
        maxUpside = Math.max(maxUpside, (v / baseMcap - 1) * 100);
        maxDrawdown = Math.max(maxDrawdown, (1 - v / peak) * 100); // peak-to-later-trough
      }
      row[label] = { maxUpsidePct: Number(maxUpside.toFixed(1)), maxDrawdownFromPeakPct: Number(maxDrawdown.toFixed(1)), snapshots: pts.length };
    }
    out.push(row);
  }
  console.log(JSON.stringify({ shadowOutcomes: out, tokensWithSignals: firstSignals.length, note: 'shadow-only; horizons reported only when elapsed AND snapshot-covered; synthetic rows excluded' }, null, 2));
  await prisma.$disconnect();
}

const cmd = process.argv[2];
const run = { start, status, stop, report }[cmd as 'start'];
if (!run) { console.error('usage: shadow-run-controller.ts <start|status|stop|report> [--days N] [--resume <runId>]'); process.exit(2); }
run().catch((e) => { console.error('controller failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
