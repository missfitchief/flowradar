import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LOG_DIR, REPO_ROOT, STATE_DIR, TASKS, processAlive, readRootEnv, readState,
  roleLog, safeTaskRun, sleep, tcpReady, waitFor, writeState
} from './flowradar-runtime-lib.mjs';

const startupLog = path.join(LOG_DIR, 'startup.log');
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(startupLog, line, 'utf8');
}

async function startRole(role, readiness, timeoutMs = 120_000) {
  log(`starting role=${role} task=${TASKS[role]}`);
  safeTaskRun(TASKS[role]);
  const ok = await waitFor(async () => {
    const state = readState(role);
    return Boolean(state && processAlive(state.supervisorPid) && await readiness(state));
  }, timeoutMs, 1_000);
  if (!ok) throw new Error(`${role} did not become ready within ${timeoutMs}ms`);
  const state = readState(role);
  log(`ready role=${role} supervisorPid=${state.supervisorPid} childPid=${state.childPid ?? 'n/a'}`);
  return state;
}

async function telegramHealth(state) {
  const env = readRootEnv();
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !processAlive(state.childPid)) return false;
  const base = `https://api.telegram.org/bot${token}`;
  try {
    const [meResponse, webhookResponse] = await Promise.all([
      fetch(`${base}/getMe`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${base}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) })
    ]);
    const me = await meResponse.json();
    const webhook = await webhookResponse.json();
    if (!me.ok || me.result?.username !== 'simbawalletfinderbot') return false;
    if (!webhook.ok || webhook.result?.url) return false;
    const logPath = path.join(LOG_DIR, 'telegram.log');
    const recent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-200_000) : '';
    return !/409 Conflict/i.test(recent);
  } catch { return false; }
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`FlowRadar startup orchestration started pid=${process.pid} repo=${REPO_ROOT}`);
  writeState('startup', { status: 'starting', supervisorPid: process.pid, startedAt });
  const states = {};
  states.postgres = await startRole('postgres', async (state) => state.status === 'healthy' && await tcpReady(5439), 120_000);
  states.receiver = await startRole('receiver', async (state) => state.status === 'running' && await tcpReady(5188), 180_000);
  states.tunnel = await startRole('tunnel', async (state) => state.status === 'healthy' && state.alchemyWebhookUpdated === true && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(state.publicUrl ?? ''), 180_000);
  states.worker = await startRole('worker', async (state) => state.status === 'running' && processAlive(state.childPid), 120_000);
  states.intelligence = await startRole('intelligence', async (state) => state.status === 'running' && processAlive(state.childPid), 120_000);
  states.telegram = await startRole('telegram', telegramHealth, 120_000);

  const receipt = {
    status: 'healthy', supervisorPid: process.pid, startedAt,
    completedAt: new Date().toISOString(), repoRoot: REPO_ROOT, mockMode: false,
    publicUrl: states.tunnel.publicUrl,
    alchemyWebhookUpdated: states.tunnel.alchemyWebhookUpdated,
    remoteAddressCount: states.tunnel.remoteAddressCount,
    publicRouteStatus: states.tunnel.publicRouteStatus,
    roles: Object.fromEntries(Object.entries(states).map(([role, state]) => [role, { supervisorPid: state.supervisorPid, childPid: state.childPid, status: state.status }]))
  };
  writeState('startup', receipt);
  log(`FlowRadar startup orchestration complete publicUrl=${receipt.publicUrl} remoteAddressCount=${receipt.remoteAddressCount}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`startup failed: ${message}`);
  writeState('startup', { status: 'failed', supervisorPid: process.pid, lastError: message });
  process.exitCode = 1;
});
