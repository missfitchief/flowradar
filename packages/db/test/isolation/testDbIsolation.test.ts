// FlowRadar — TEST/LIVE database isolation (overnight Task A).
//
// A test fixture previously leaked into the live LITE DB because tests
// resolved the SAME DATABASE_URL as operators. These tests prove the fix:
// under vitest, resolution AUTOMATICALLY targets a distinct *_test database
// and any live/test collision FAILS CLOSED (throws before any query runs).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../../src/client';
import { resolveDatabaseUrl } from '../../src/client';
import {
  LIVE_LITE_DATABASE_URL,
  TEST_LITE_DATABASE_URL,
  TestDbIsolationError,
  resolveDatabaseUrlForEnv
} from '../../src/testDb';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs); s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false));
  });
}

describe('resolveDatabaseUrlForEnv (pure fail-closed rules)', () => {
  it('under vitest, resolves to the dedicated *_test database — NEVER the live URL', () => {
    const url = resolveDatabaseUrlForEnv({ VITEST: 'true' });
    expect(url).toBe(TEST_LITE_DATABASE_URL);
    expect(url).not.toBe(LIVE_LITE_DATABASE_URL);
    expect(new URL(url).pathname.endsWith('_test')).toBe(true);
  });

  it('under vitest, DATABASE_URL (live) is IGNORED — tests cannot be pointed at live via the ambient var', () => {
    const url = resolveDatabaseUrlForEnv({ VITEST: 'true', DATABASE_URL: LIVE_LITE_DATABASE_URL });
    expect(url).toBe(TEST_LITE_DATABASE_URL);
  });

  it('FAILS CLOSED: an explicit TEST_DATABASE_URL whose db name does not end in _test throws', () => {
    expect(() =>
      resolveDatabaseUrlForEnv({ VITEST: 'true', TEST_DATABASE_URL: LIVE_LITE_DATABASE_URL })
    ).toThrow(TestDbIsolationError);
    expect(() =>
      resolveDatabaseUrlForEnv({ VITEST: 'true', TEST_DATABASE_URL: 'postgresql://flowradar:flowradar@localhost:5439/flowradar' })
    ).toThrow(/_test/);
  });

  it('FAILS CLOSED: a test URL that equals the live URL throws even if suffixed _test', () => {
    // Operator sets BOTH to the same _test db: same-identity collision (live
    // work would then hit the test db, or vice versa) — refuse to run.
    expect(() =>
      resolveDatabaseUrlForEnv({
        VITEST: 'true',
        DATABASE_URL: 'postgresql://flowradar:flowradar@localhost:5439/foo_test',
        TEST_DATABASE_URL: 'postgresql://flowradar:flowradar@localhost:5439/foo_test'
      })
    ).toThrow(TestDbIsolationError);
  });

  it('FAILS CLOSED: an unparsable TEST_DATABASE_URL throws rather than falling back to live', () => {
    expect(() => resolveDatabaseUrlForEnv({ VITEST: 'true', TEST_DATABASE_URL: 'not a url' })).toThrow(TestDbIsolationError);
  });

  it('FAILS CLOSED: identifier-injection via percent-encoding throws (safe charset only)', () => {
    // Decodes to `x" WITH TEMPLATE flowradar -- _test` — ends '_test' and is
    // local, but the charset rule must kill it before any SQL can exist.
    expect(() =>
      resolveDatabaseUrlForEnv({
        VITEST: 'true',
        TEST_DATABASE_URL: 'postgresql://u:p@localhost:5439/x%22%20WITH%20TEMPLATE%20flowradar%20--%20_test'
      })
    ).toThrow(/identifier-injection|characters outside/);
  });

  it('FAILS CLOSED: a _test database on a NON-LOCAL host throws (could be production)', () => {
    expect(() =>
      resolveDatabaseUrlForEnv({ VITEST: 'true', TEST_DATABASE_URL: 'postgresql://u:p@db.prod.example.com:5432/foo_test' })
    ).toThrow(/not local/);
  });

  it('FAILS CLOSED: collision detection is CANONICAL — query params/credentials cannot defeat it', () => {
    // Same host+port+db as the live URL, disguised with a query param and
    // different credentials: raw strings differ, identity is the same.
    expect(() =>
      resolveDatabaseUrlForEnv({
        VITEST: 'true',
        DATABASE_URL: 'postgresql://flowradar:flowradar@localhost:5439/foo_test',
        TEST_DATABASE_URL: 'postgresql://other:creds@LOCALHOST:5439/foo_test?connection_limit=1'
      })
    ).toThrow(TestDbIsolationError);
  });

  it('outside vitest, behavior is unchanged: DATABASE_URL else the live LITE default', () => {
    expect(resolveDatabaseUrlForEnv({})).toBe(LIVE_LITE_DATABASE_URL);
    expect(resolveDatabaseUrlForEnv({ DATABASE_URL: 'postgresql://u:p@h:5/x' })).toBe('postgresql://u:p@h:5/x');
  });
});

describe('live client resolution in THIS test process', () => {
  it('the actual resolveDatabaseUrl() used by the prisma singleton targets the test db', () => {
    const url = resolveDatabaseUrl();
    expect(new URL(url).pathname.endsWith('_test')).toBe(true);
  });
});

const PORT_OPEN = await probePort('localhost', 5439);

describe.skipIf(!PORT_OPEN)('integration: writes land in the TEST db only', () => {
  const MARKER = 'ISOTESTMARKERWALLETxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 43);
  let liveClient: PrismaClient;

  beforeAll(() => {
    // Explicit read-only-use client pinned to the LIVE db. Constructing a
    // client with an explicit URL bypasses the vitest redirect BY DESIGN —
    // the guard protects the ambient/default resolution, and this test only
    // ever READS through this client.
    liveClient = new PrismaClient({ datasources: { db: { url: LIVE_LITE_DATABASE_URL } } });
  });
  afterAll(async () => {
    await prisma.wallet.deleteMany({ where: { address: MARKER } });
    await liveClient.$disconnect();
  });

  it('a row written via the default client exists in the test DB and NOT in the live DB', async () => {
    await prisma.wallet.deleteMany({ where: { address: MARKER } });
    await prisma.wallet.create({
      data: { address: MARKER, chain: 'SOLANA', firstSeenAt: new Date(), lastActiveAt: new Date(), status: 'observation_only' }
    });
    const inTest = await prisma.wallet.count({ where: { address: MARKER } });
    const inLive = await liveClient.wallet.count({ where: { address: MARKER } });
    expect(inTest).toBe(1);
    expect(inLive).toBe(0); // the live DB never sees test writes
  });

  it('test and live identities are explicit and distinct', () => {
    const testDb = new URL(resolveDatabaseUrl()).pathname;
    const liveDb = new URL(LIVE_LITE_DATABASE_URL).pathname;
    expect(testDb).not.toBe(liveDb);
  });
});
