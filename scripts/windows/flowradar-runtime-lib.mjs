import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME_ROOT = path.join(REPO_ROOT, '.runtime');
export const LOG_DIR = path.join(RUNTIME_ROOT, 'logs');
export const STATE_DIR = path.join(RUNTIME_ROOT, 'state');
export const LOCK_DIR = path.join(RUNTIME_ROOT, 'locks');
export const ROOT_ENV = path.join(REPO_ROOT, '.env');
export const NODE_PATH = process.execPath;
export const TASKS = Object.freeze({
  startup: 'FlowRadar-Startup',
  postgres: 'FlowRadar-PostgreSQL',
  receiver: 'FlowRadar-Receiver',
  tunnel: 'FlowRadar-Cloudflare-Tunnel',
  worker: 'FlowRadar-Worker',
  intelligence: 'FlowRadar-Intelligence',
  telegram: 'FlowRadar-Telegram'
});

for (const directory of [RUNTIME_ROOT, LOG_DIR, STATE_DIR, LOCK_DIR]) fs.mkdirSync(directory, { recursive: true });

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function readRootEnv() {
  const output = {};
  if (!fs.existsSync(ROOT_ENV)) return output;
  for (const raw of fs.readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const index = raw.indexOf('=');
    if (index < 1) continue;
    const name = raw.slice(0, index).trim();
    let value = raw.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    output[name] = value;
  }
  return output;
}

export function runtimeEnv() {
  const root = readRootEnv();
  const env = { ...process.env, ...root, MOCK_MODE: 'false', FLOWRADAR_REPO_ROOT: REPO_ROOT };
  return env;
}

function secretValues() {
  const env = readRootEnv();
  return Object.entries(env)
    .filter(([name, value]) => /TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL|RPC_URL|AUTH/i.test(name) && String(value).length >= 6)
    .map(([, value]) => String(value))
    .sort((a, b) => b.length - a.length);
}

export function sanitize(value) {
  let text = String(value ?? '');
  for (const secret of secretValues()) text = text.split(secret).join('<redacted>');
  text = text
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://<redacted>@')
    .replace(/(https?:\/\/[^\s/]+\/v2\/)[A-Za-z0-9._~-]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|signing[_-]?key|authorization|auth[_-]?token|bot[_-]?token)["'=:\s]+)[^\s,"'}]+/gi, '$1<redacted>');
  return text;
}

export function roleLog(role, message) {
  const line = `${new Date().toISOString()} ${sanitize(message)}\n`;
  fs.appendFileSync(path.join(LOG_DIR, `${role}.log`), line, 'utf8');
}

export function readState(role) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${role}.json`), 'utf8')); }
  catch { return null; }
}

export function writeState(role, value) {
  const target = path.join(STATE_DIR, `${role}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...value, role, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  try { fs.renameSync(temporary, target); }
  catch { fs.copyFileSync(temporary, target); fs.unlinkSync(temporary); }
}

export function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

export function processCommandLine(pid) {
  if (!processAlive(pid)) return '';
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\"; if($p){$p.CommandLine}`;
  try { return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return ''; }
}

export function stopProcessTree(pid) {
  if (!processAlive(pid)) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

export function acquireRoleLock(role) {
  const lockPath = path.join(LOCK_DIR, `${role}.lock`);
  if (fs.existsSync(lockPath)) {
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* stale */ }
    const command = prior?.pid ? processCommandLine(Number(prior.pid)) : '';
    if (Number(prior?.pid) !== process.pid && command.includes('flowradar-component-supervisor.mjs') && command.includes(role)) {
      roleLog(role, `duplicate supervisor suppressed; active supervisor pid=${prior.pid}`);
      return null;
    }
    try { fs.unlinkSync(lockPath); } catch { /* retried by open below */ }
  }
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, role, startedAt: new Date().toISOString() }));
    const release = () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} };
    return { fd, release };
  } catch (error) {
    roleLog(role, `duplicate supervisor suppressed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function cleanupStaleChild(role, signature) {
  const prior = readState(role);
  if (!prior?.childPid || processAlive(prior.supervisorPid)) return;
  const command = processCommandLine(Number(prior.childPid));
  if (command && command.includes(signature)) {
    roleLog(role, `stale child detected and stopped pid=${prior.childPid}`);
    stopProcessTree(Number(prior.childPid));
  }
}

export function spawnLogged(role, executable, args, options = {}) {
  roleLog(role, `starting child executable=${path.basename(executable)}`);
  const child = spawn(executable, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? runtimeEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    const lines = readline.createInterface({ input: stream });
    lines.on('line', (line) => {
      roleLog(role, `[${streamName}] ${line}`);
      options.onLine?.(line, streamName);
    });
  }
  child.on('error', (error) => roleLog(role, `child process error: ${error.message}`));
  return child;
}

export function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

export function tcpReady(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; }
    catch (error) { lastError = error; }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return false;
}

export function updateRootEnvValue(name, value) {
  const original = fs.existsSync(ROOT_ENV) ? fs.readFileSync(ROOT_ENV, 'utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}=`);
  let found = false;
  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    return `${name}=${value}`;
  });
  if (!found) next.push(`${name}=${value}`);
  fs.writeFileSync(ROOT_ENV, next.join(newline), 'utf8');
}

export async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
  return body ? JSON.parse(body) : {};
}

export function flattenWebhooks(value) {
  if (Array.isArray(value)) return value.flatMap(flattenWebhooks);
  if (!value || typeof value !== 'object') return [];
  if (typeof value.id === 'string' && typeof value.webhook_url === 'string') return [value];
  if ('data' in value) return flattenWebhooks(value.data);
  return [];
}

export async function updateExistingSolanaWebhook(publicUrl) {
  const env = readRootEnv();
  const auth = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
  const webhookId = env.ALCHEMY_SOLANA_WEBHOOK_ID?.trim();
  if (!auth || !webhookId) throw new Error('Alchemy Notify auth or existing Solana webhook ID is not configured');
  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/api/webhooks/alchemy/solana`;
  const headers = { 'content-type': 'application/json', 'X-Alchemy-Token': auth };
  await fetchJson('https://dashboard.alchemy.com/api/update-webhook', {
    method: 'PUT', headers, body: JSON.stringify({ webhook_id: webhookId, webhook_url: webhookUrl, is_active: true })
  });
  const team = await fetchJson('https://dashboard.alchemy.com/api/team-webhooks', { headers: { 'X-Alchemy-Token': auth } });
  const hook = flattenWebhooks(team).find((item) => item.id === webhookId);
  if (!hook) throw new Error('Existing Solana webhook was not returned after URL update');
  if (hook.webhook_url !== webhookUrl) throw new Error('Alchemy webhook URL did not match the new tunnel URL');
  if (hook.is_active !== true) throw new Error('Existing Solana webhook is not active');
  const configuredSigningKey = env.ALCHEMY_SOLANA_WEBHOOK_SIGNING_KEY?.trim();
  const signingKeyUnchanged = !configuredSigningKey || !hook.signing_key || hook.signing_key === configuredSigningKey;
  if (!signingKeyUnchanged) throw new Error('Alchemy signing key changed unexpectedly');

  let remoteAddressCount = 0;
  let after = null;
  const seenCursors = new Set();
  do {
    const url = new URL('https://dashboard.alchemy.com/api/webhook-addresses');
    url.searchParams.set('webhook_id', webhookId);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const page = await fetchJson(url, { headers: { 'X-Alchemy-Token': auth } });
    const rows = Array.isArray(page.data) ? page.data : Array.isArray(page.addresses) ? page.addresses : [];
    remoteAddressCount += rows.length;
    const next = page.pagination?.cursors?.after || null;
    if (!next || seenCursors.has(next)) after = null;
    else { seenCursors.add(next); after = next; }
  } while (after);
  return { webhookUrl, remoteAddressCount, webhookIdUnchanged: true, signingKeyUnchanged, active: true };
}

export async function verifyPublicReceiver(publicUrl, timeoutMs = 45_000) {
  const route = `${publicUrl.replace(/\/$/, '')}/api/webhooks/alchemy/solana`;
  let lastStatus = null;
  const ready = await waitFor(async () => {
    try {
      const response = await fetch(route, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      lastStatus = response.status;
      return response.status >= 200 && response.status < 500;
    } catch { return false; }
  }, timeoutMs, 1_000);
  if (!ready) throw new Error('Public Solana webhook route did not reach the receiver');
  return lastStatus;
}

export function safeTaskRun(taskName) {
  const result = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0 && !/already running/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Could not start scheduled task ${taskName} (exit ${result.status})`);
  }
}
