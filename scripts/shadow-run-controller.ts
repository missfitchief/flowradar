// FlowRadar — supervised, resumable SHADOW-RUN controller (Priority 7).
//
// Runs the normal worker (normal speeds — never WORKER_FAST) as a TRACKED
// child process with a persistent run record, so a multi-day shadow run is
// controlled, checkpointed, and cleanly stoppable — never an orphan:
//   start [--days N] [--resume <runId>]  create/resume a run, spawn worker,
//                                        supervise: heartbeat every 15 min,
//                                        checkpoint daily, stop at target end
//   status                               show run + worker liveness
//   stop                                 graceful shutdown + final checkpoint
//   report                               shadow outcomes from DB (1h/6h/24h/72h
//                                        mcap max-upside/drawdown per stealth
//                                        signal token) — read-only
//
// State lives in runs/<runId>/ (gitignored): state.json, heartbeats.jsonl,
// checkpoint-*.json, worker.log. Heartbeats capture the trust invariant
// (signal_eligible count), DB growth, provider sync errors, worker RSS.
// ANALYTICS ONLY: no execution, no keys beyond read APIs the worker already
// uses. Provider budget: the worker's own caps (WALLET_ACTIVITY_MAX_WALLETS,
// HELIUS_RPS) — printed with a projected daily request count at start.
// Usage: npx tsx scripts/shadow-run-controller.ts <start|status|stop|report> [...]
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../packages/db/src/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'runs');
mkdirSync(RUNS_DIR, { recursive: true });
const HEARTBEAT_MIN = 15;
const ACTIVE_FILE = path.join(RUNS_DIR, 'ACTIVE');

interface RunState {
  runId: string;
  startedAt: string;
  endTargetAt: string;
  workerPid: number | null;
  status: 'running' | 'stopped' | 'completed';
  env: { walletBudget: string; heliusRps: string };
  baseline: Record<string, number>;
  lastHeartbeatAt?: string;
  stoppedAt?: string;
  notes: string[];
}

function statePath(runId: string): string { return path.join(RUNS_DIR, runId, 'state.json'); }
function loadState(runId: string): RunState { return JSON.parse(readFileSync(statePath(runId), 'utf-8')) as RunState; }
function saveState(s: RunState): void { writeFileSync(statePath(s.runId), JSON.stringify(s, null, 2)); }
function activeRunId(): string | null { return existsSync(ACTIVE_FILE) ? readFileSync(ACTIVE_FILE, 'utf-8').trim() || null : null; }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function workerRssMb(pid: number): number | null {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' });
    const m = out.match(/"([\d,.]+) K"/);
    return m ? Math.round(Number(m[1]!.replace(/[,.]/g, '')) / 1024) : null;
  } catch { return null; }
}
function killTree(pid: number): void {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
}

async function census(): Promise<Record<string, number>> {
  const rec: Record<string, number> = {
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
  return rec;
}

async function heartbeat(s: RunState): Promise<void> {
  const c = await census();
  const hb = {
    ts: new Date().toISOString(),
    workerAlive: s.workerPid !== null && pidAlive(s.workerPid),
    workerRssMb: s.workerPid !== null ? workerRssMb(s.workerPid) : null,
    census: c,
    delta: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v - (s.baseline[k] ?? 0)])),
    trustInvariant: c.eligible === s.baseline.eligible ? 'HOLDS' : `CHANGED ${s.baseline.eligible} -> ${c.eligible} (investigate)`
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

async function start(): Promise<void> {
  const resumeIdx = process.argv.indexOf('--resume');
  const daysIdx = process.argv.indexOf('--days');
  const days = daysIdx > -1 ? Math.max(1, Math.min(14, Number(process.argv[daysIdx + 1]) || 7)) : 7;

  const existing = activeRunId();
  if (existing && resumeIdx === -1) {
    const st = loadState(existing);
    if (st.status === 'running' && st.workerPid && pidAlive(st.workerPid)) {
      throw new Error(`run ${existing} is already ACTIVE with a live worker (pid ${st.workerPid}) — use status/stop, never two workers`);
    }
  }

  let s: RunState;
  if (resumeIdx > -1) {
    s = loadState(String(process.argv[resumeIdx + 1]));
    if (s.workerPid && pidAlive(s.workerPid)) throw new Error(`run ${s.runId} already has a live worker (pid ${s.workerPid})`);
    s.notes.push(`resumed at ${new Date().toISOString()}`);
  } else {
    const runId = `shadow-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
    s = {
      runId,
      startedAt: new Date().toISOString(),
      endTargetAt: new Date(Date.now() + days * 86400_000).toISOString(),
      workerPid: null,
      status: 'running',
      env: {
        walletBudget: process.env.WALLET_ACTIVITY_MAX_WALLETS ?? '50',
        heliusRps: process.env.HELIUS_RPS ?? '5'
      },
      baseline: await census(),
      notes: []
    };
    saveState(s);
    await checkpoint(s, 'start');
  }
  writeFileSync(ACTIVE_FILE, s.runId);

  // Provider budget projection — printed, never hidden.
  const budget = Number(s.env.walletBudget);
  const projectedDaily = Math.round((budget * (86400 / 45)) * 1.2); // pages≈1/wallet post-backfill, +20% margin
  console.log(JSON.stringify({
    runId: s.runId, endTargetAt: s.endTargetAt,
    providerBudget: { walletActivityMaxWallets: budget, heliusRps: Number(s.env.heliusRps), projectedHeliusRequestsPerDay: projectedDaily },
    note: 'normal worker speeds; WORKER_FAST never set; stop anytime: shadow-run-controller stop'
  }));

  const log = path.join(RUNS_DIR, s.runId, 'worker.log');
  const child = spawn('npx', ['tsx', 'apps/worker/src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_MODE: 'false', WALLET_ACTIVITY_MAX_WALLETS: s.env.walletBudget, HELIUS_RPS: s.env.heliusRps, WORKER_FAST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: false
  });
  child.stdout.on('data', (d: Buffer) => appendFileSync(log, d));
  child.stderr.on('data', (d: Buffer) => appendFileSync(log, d));
  s.workerPid = child.pid ?? null;
  saveState(s);
  console.log(JSON.stringify({ workerStarted: true, pid: s.workerPid, log }));

  let lastCheckpointDay = new Date().toISOString().slice(0, 10);
  const shutdown = async (reason: string) => {
    console.log(JSON.stringify({ shuttingDown: reason }));
    if (s.workerPid) killTree(s.workerPid);
    s.status = reason === 'end-target-reached' ? 'completed' : 'stopped';
    s.stoppedAt = new Date().toISOString();
    saveState(s);
    await checkpoint(s, `final-${reason}`);
    writeFileSync(ACTIVE_FILE, '');
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));

  // Supervision loop: heartbeat every 15 min, daily checkpoint, honest exit
  // at the end target. Worker death is recorded and supervised (one restart
  // attempt per heartbeat, never a silent orphan).
  for (;;) {
    await new Promise((r) => setTimeout(r, HEARTBEAT_MIN * 60_000));
    await heartbeat(s);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== lastCheckpointDay) { await checkpoint(s, day); lastCheckpointDay = day; }
    if (s.workerPid && !pidAlive(s.workerPid)) {
      s.notes.push(`worker died, restarting at ${new Date().toISOString()}`);
      const revived = spawn('npx', ['tsx', 'apps/worker/src/index.ts'], {
        cwd: REPO_ROOT,
        env: { ...process.env, MOCK_MODE: 'false', WALLET_ACTIVITY_MAX_WALLETS: s.env.walletBudget, HELIUS_RPS: s.env.heliusRps, WORKER_FAST: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });
      revived.stdout.on('data', (d: Buffer) => appendFileSync(log, d));
      revived.stderr.on('data', (d: Buffer) => appendFileSync(log, d));
      s.workerPid = revived.pid ?? null;
      saveState(s);
    }
    if (new Date() >= new Date(s.endTargetAt)) await shutdown('end-target-reached');
  }
}

async function status(): Promise<void> {
  const id = activeRunId();
  if (!id) { console.log(JSON.stringify({ activeRun: null })); await prisma.$disconnect(); return; }
  const s = loadState(id);
  console.log(JSON.stringify({
    runId: s.runId, status: s.status, startedAt: s.startedAt, endTargetAt: s.endTargetAt,
    workerPid: s.workerPid, workerAlive: s.workerPid !== null && pidAlive(s.workerPid),
    lastHeartbeatAt: s.lastHeartbeatAt ?? null, notes: s.notes.slice(-3)
  }, null, 2));
  await prisma.$disconnect();
}

async function stop(): Promise<void> {
  const id = activeRunId();
  if (!id) { console.log('no active run'); await prisma.$disconnect(); return; }
  const s = loadState(id);
  if (s.workerPid) killTree(s.workerPid);
  s.status = 'stopped';
  s.stoppedAt = new Date().toISOString();
  saveState(s);
  await checkpoint(s, 'final-manual-stop');
  writeFileSync(ACTIVE_FILE, '');
  console.log(JSON.stringify({ stopped: s.runId, finalCheckpoint: true }));
  await prisma.$disconnect();
}

/** Shadow outcomes, read-only: per stealth-signal token, mcap max-upside and
 *  max-drawdown over the 1h/6h/24h/72h following the FIRST non-WATCHING
 *  snapshot. Reported only for horizons that have fully elapsed. */
async function report(): Promise<void> {
  const firstSignals = await prisma.stealthSnapshot.groupBy({
    by: ['tokenId'],
    where: { state: { not: 'WATCHING' } },
    _min: { computedAt: true }
  });
  const out: Record<string, unknown>[] = [];
  for (const sig of firstSignals.slice(0, 100)) {
    const t0 = sig._min.computedAt!;
    const base = await prisma.tokenMarketSnapshot.findFirst({
      where: { tokenId: sig.tokenId, ts: { lte: t0 } }, orderBy: { ts: 'desc' }, select: { marketCapUsd: true }
    });
    const row: Record<string, unknown> = { tokenId: sig.tokenId, signalAt: t0.toISOString(), baseMcap: base ? Number(base.marketCapUsd) : null };
    for (const [label, hours] of [['h1', 1], ['h6', 6], ['h24', 24], ['h72', 72]] as const) {
      const end = new Date(t0.getTime() + hours * 3600_000);
      if (end > new Date()) { row[label] = 'not yet elapsed'; continue; }
      const agg = await prisma.tokenMarketSnapshot.aggregate({
        where: { tokenId: sig.tokenId, ts: { gt: t0, lte: end } },
        _max: { marketCapUsd: true }, _min: { marketCapUsd: true }
      });
      const mx = agg._max.marketCapUsd; const mn = agg._min.marketCapUsd;
      row[label] = base && mx && mn && Number(base.marketCapUsd) > 0
        ? { maxUpsidePct: Number(((Number(mx) / Number(base.marketCapUsd) - 1) * 100).toFixed(1)), maxDrawdownPct: Number(((1 - Number(mn) / Number(base.marketCapUsd)) * 100).toFixed(1)) }
        : 'no market data';
    }
    out.push(row);
  }
  console.log(JSON.stringify({ shadowOutcomes: out, tokensWithSignals: firstSignals.length, note: 'shadow-only; horizons reported only after they fully elapse' }, null, 2));
  await prisma.$disconnect();
}

const cmd = process.argv[2];
const run = { start, status, stop, report }[cmd as 'start'];
if (!run) { console.error('usage: shadow-run-controller.ts <start|status|stop|report> [--days N] [--resume <runId>]'); process.exit(2); }
run().catch((e) => { console.error('controller failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
