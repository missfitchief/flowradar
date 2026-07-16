import fs from 'node:fs';
import path from 'node:path';
import {
  LOG_DIR, NODE_PATH, REPO_ROOT, acquireRoleLock, cleanupStaleChild, processAlive,
  readRootEnv, roleLog, runtimeEnv, sleep, spawnLogged, stopProcessTree, tcpReady,
  updateExistingSolanaWebhook, updateRootEnvValue, verifyPublicReceiver, waitForExit, writeState
} from './flowradar-runtime-lib.mjs';

const role = process.argv[2];
const supported = new Set(['postgres', 'receiver', 'tunnel', 'worker', 'intelligence', 'telegram']);
if (!supported.has(role)) throw new Error(`Unsupported FlowRadar role: ${role ?? '<missing>'}`);

const lock = acquireRoleLock(role);
if (!lock) process.exit(0);

let child = null;
let stopping = false;
let restartCount = 0;
const supervisorStartedAt = new Date().toISOString();

function state(status, extra = {}) {
  writeState(role, {
    status, supervisorPid: process.pid, childPid: child?.pid ?? null,
    supervisorStartedAt, restartCount, mockMode: false, repoRoot: REPO_ROOT, ...extra
  });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  roleLog(role, `supervisor stopping signal=${signal}`);
  state('stopping');
  if (child?.pid) stopProcessTree(child.pid);
  lock.release();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGHUP', () => void shutdown('SIGHUP'));
process.once('exit', () => lock.release());
process.on('uncaughtException', (error) => { roleLog(role, `uncaught exception: ${error.message}`); state('failed', { lastError: error.message }); lock.release(); process.exit(1); });
process.on('unhandledRejection', (error) => { const message = error instanceof Error ? error.message : String(error); roleLog(role, `unhandled rejection: ${message}`); state('failed', { lastError: message }); lock.release(); process.exit(1); });

function commandFor(currentRole) {
  const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (currentRole === 'receiver') return { executable: NODE_PATH, args: [nextBin, 'start', '-p', '5188'], cwd: path.join(REPO_ROOT, 'apps', 'web'), signature: 'next' };
  if (currentRole === 'worker') return { executable: NODE_PATH, args: ['--import', 'tsx', path.join(REPO_ROOT, 'apps', 'worker', 'src', 'index.ts')], cwd: REPO_ROOT, signature: 'apps\\worker\\src\\index.ts' };
  if (currentRole === 'intelligence') return { executable: NODE_PATH, args: ['--import', 'tsx', path.join(REPO_ROOT, 'scripts', 'intelligence-lifecycle-daemon.mts')], cwd: REPO_ROOT, signature: 'intelligence-lifecycle-daemon.mts' };
  if (currentRole === 'telegram') return { executable: NODE_PATH, args: ['--import', 'tsx', path.join(REPO_ROOT, 'apps', 'telegram', 'src', 'index.ts')], cwd: REPO_ROOT, signature: 'apps\\telegram\\src\\index.ts' };
  throw new Error(`No managed command for ${currentRole}`);
}

async function runManaged(currentRole) {
  const command = commandFor(currentRole);
  cleanupStaleChild(currentRole, command.signature);
  while (!stopping) {
    const env = runtimeEnv();
    child = spawnLogged(currentRole, command.executable, command.args, { cwd: command.cwd, env });
    state('running');
    const result = await waitForExit(child);
    if (stopping) break;
    restartCount += 1;
    roleLog(currentRole, `child exited code=${result.code ?? 'null'} signal=${result.signal ?? 'none'}; restarting in 3s`);
    state('restarting', { lastExitCode: result.code, lastSignal: result.signal });
    child = null;
    await sleep(3_000);
  }
}

async function runPostgres() {
  while (!stopping) {
    if (await tcpReady(5439)) {
      state('healthy', { port: 5439 });
      await sleep(5_000);
      continue;
    }
    restartCount += 1;
    roleLog(role, 'PostgreSQL is unavailable; running idempotent local ensure');
    child = spawnLogged(role, NODE_PATH, ['--import', 'tsx', path.join(REPO_ROOT, 'scripts', 'db-local.ts'), 'ensure'], { cwd: REPO_ROOT, env: runtimeEnv() });
    state('starting', { port: 5439 });
    const result = await waitForExit(child);
    child = null;
    if (!(await tcpReady(5439))) {
      state('degraded', { port: 5439, lastExitCode: result.code });
      await sleep(3_000);
    }
  }
}

function cloudflaredPath() {
  const env = readRootEnv();
  const candidates = [
    env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Users\\akki\\AppData\\Local\\Programs\\cloudflared\\cloudflared.exe'
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('cloudflared.exe was not found');
  return found;
}

async function runTunnel() {
  cleanupStaleChild(role, 'cloudflared');
  while (!stopping) {
    let resolveUrl;
    const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });
    child = spawnLogged(role, cloudflaredPath(), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:5188'], {
      cwd: REPO_ROOT, env: runtimeEnv(),
      onLine(line) { const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); if (match) resolveUrl(match[0]); }
    });
    state('starting', { target: 'http://127.0.0.1:5188' });
    const exited = waitForExit(child).then((result) => ({ type: 'exit', result }));
    const discovered = urlPromise.then((publicUrl) => ({ type: 'url', publicUrl }));
    const timedOut = sleep(60_000).then(() => ({ type: 'timeout' }));
    const first = await Promise.race([exited, discovered, timedOut]);
    if (first.type !== 'url') {
      if (child?.pid) stopProcessTree(child.pid);
      restartCount += 1;
      roleLog(role, first.type === 'timeout' ? 'Quick Tunnel URL discovery timed out; restarting in 3s' : 'Quick Tunnel exited before publishing a URL; restarting in 3s');
      state('restarting', { lastError: first.type === 'timeout' ? 'url_discovery_timeout' : 'tunnel_exited_before_url' });
      child = null;
      await sleep(3_000);
      continue;
    }

    const publicUrl = first.publicUrl;
    updateRootEnvValue('FLOWRADAR_PUBLIC_URL', publicUrl);
    roleLog(role, `new Quick Tunnel URL persisted: ${publicUrl}`);
    let ready = false;
    let readinessAttempts = 0;
    while (!stopping && processAlive(child.pid) && !ready) {
      readinessAttempts += 1;
      try {
        const publicRouteStatus = await verifyPublicReceiver(publicUrl);
        const alchemy = await updateExistingSolanaWebhook(publicUrl);
        ready = true;
        state('healthy', {
          publicUrl, publicRouteStatus, alchemyWebhookUpdated: true,
          remoteAddressCount: alchemy.remoteAddressCount,
          webhookIdUnchanged: alchemy.webhookIdUnchanged,
          signingKeyUnchanged: alchemy.signingKeyUnchanged
        });
        roleLog(role, `public receiver reachable status=${publicRouteStatus}; existing Solana webhook updated; remoteAddressCount=${alchemy.remoteAddressCount}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        roleLog(role, `tunnel readiness retry: ${message}`);
        state('degraded', { publicUrl, alchemyWebhookUpdated: false, lastError: message });
        if (readinessAttempts >= 2) {
          roleLog(role, 'Quick Tunnel hostname remained unreachable after two readiness windows; rotating the tunnel URL');
          stopProcessTree(child.pid);
          break;
        }
        await sleep(15_000);
      }
    }
    if (processAlive(child?.pid)) await exited;
    if (!stopping) {
      restartCount += 1;
      roleLog(role, 'Quick Tunnel child exited; restarting in 3s');
      state('restarting', { previousPublicUrl: publicUrl });
      child = null;
      await sleep(3_000);
    }
  }
}

roleLog(role, `supervisor started pid=${process.pid} repo=${REPO_ROOT} MOCK_MODE=false`);
state('starting');
if (role === 'postgres') await runPostgres();
else if (role === 'tunnel') await runTunnel();
else await runManaged(role);
