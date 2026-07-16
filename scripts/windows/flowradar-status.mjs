import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LOG_DIR, TASKS, processAlive, readRootEnv, readState, tcpReady } from './flowradar-runtime-lib.mjs';

function taskState(name) {
  try {
    const output = execFileSync('schtasks.exe', ['/Query', '/TN', name, '/FO', 'LIST', '/V'], { encoding: 'utf8', windowsHide: true });
    const line = output.split(/\r?\n/).find((entry) => /^Status:\s*/i.test(entry));
    return line?.replace(/^Status:\s*/i, '').trim() || 'registered';
  } catch { return 'missing'; }
}

async function main() {
  const roles = ['postgres', 'receiver', 'tunnel', 'worker', 'intelligence', 'telegram'];
  const states = Object.fromEntries(roles.map((role) => [role, readState(role)]));
  const env = readRootEnv();
  const telegramLog = path.join(LOG_DIR, 'telegram.log');
  const telegramTail = fs.existsSync(telegramLog) ? fs.readFileSync(telegramLog, 'utf8').slice(-200_000) : '';
  const output = {
    startupTask: TASKS.startup,
    tasks: Object.fromEntries(Object.entries(TASKS).map(([key, name]) => [key, { name, state: taskState(name) }])),
    ports: { postgres5439: await tcpReady(5439), receiver5188: await tcpReady(5188) },
    publicUrl: env.FLOWRADAR_PUBLIC_URL || null,
    remoteAddressCount: states.tunnel?.remoteAddressCount ?? null,
    telegramConflict: /409 Conflict/i.test(telegramTail),
    roles: Object.fromEntries(roles.map((role) => [role, states[role] ? {
      status: states[role].status,
      supervisorPid: states[role].supervisorPid,
      supervisorAlive: processAlive(states[role].supervisorPid),
      childPid: states[role].childPid,
      childAlive: states[role].childPid ? processAlive(states[role].childPid) : null,
      restartCount: states[role].restartCount
    } : null]))
  };
  console.log(JSON.stringify(output, null, 2));
}
await main();
