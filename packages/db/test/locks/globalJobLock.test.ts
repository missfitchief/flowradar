// FlowRadar — global job lock tests (Prerequisite B, Capital Lineage 6b).
// Each withGlobalJobLock call uses its own dedicated single-connection
// client, so two calls in ONE process genuinely contend on the PostgreSQL
// advisory lock — the same contention two separate processes would have.

import { describe, expect, it, beforeAll } from 'vitest';
import net from 'node:net';
import { withGlobalJobLock, GlobalJobLockBusyError } from '../../src/locks/globalJobLock';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dbReachable = false;
beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
});

describe.skipIf(!(await probePort('localhost', 5439)))('withGlobalJobLock', () => {
  it('SERIALIZES: two concurrent holders never overlap', async () => {
    const events: string[] = [];
    await Promise.all([
      withGlobalJobLock('job-a', async () => {
        events.push('a-enter');
        await sleep(300);
        events.push('a-exit');
      }),
      (async () => {
        await sleep(50); // ensure job-a wins the lock first
        await withGlobalJobLock('job-b', async () => {
          events.push('b-enter');
          await sleep(50);
          events.push('b-exit');
        });
      })()
    ]);

    expect(events).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('FAILS HONESTLY: acquisition times out with GlobalJobLockBusyError and mutates nothing', async () => {
    let holderDone: (() => void) | undefined;
    const holderGate = new Promise<void>((resolve) => (holderDone = resolve));

    const holder = withGlobalJobLock('long-holder', async () => {
      await holderGate;
    });
    await sleep(100); // let the holder acquire

    await expect(
      withGlobalJobLock('impatient', async () => 'should never run', { waitMs: 400, pollMs: 50 })
    ).rejects.toThrow(GlobalJobLockBusyError);

    holderDone!();
    await holder;
  });

  it('RELEASES on throw: a crashed job does not wedge the lock', async () => {
    await expect(
      withGlobalJobLock('crasher', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Immediately acquirable again.
    const result = await withGlobalJobLock('after-crash', async () => 'acquired', { waitMs: 2000 });
    expect(result).toBe('acquired');
  });

  it('returns the wrapped function result', async () => {
    expect(await withGlobalJobLock('returner', async () => 42)).toBe(42);
  });
});
