// FlowRadar — TEST/LIVE database isolation (overnight Task A).
//
// WHY THIS EXISTS. A test fixture previously leaked into the live LITE DB:
// tests resolved the exact same DATABASE_URL as operator jobs, so every
// test write landed in live data. This module makes the isolation decision
// in ONE pure, testable place with fail-closed semantics:
//
//   - Under vitest (process.env.VITEST is set by the vitest runtime in every
//     worker), resolution AUTOMATICALLY targets the dedicated test database
//     (`flowradar_test` on the same embedded LITE cluster). The ambient
//     DATABASE_URL is deliberately IGNORED in test mode — an operator shell
//     that exports the live URL can never point tests at live data.
//   - An explicit TEST_DATABASE_URL override is honored ONLY when its
//     database name ends with `_test` AND it differs from the live URL.
//     Anything else throws TestDbIsolationError BEFORE any client is built —
//     a live/test collision refuses to run rather than "probably being fine".
//   - Outside vitest, behavior is byte-for-byte the old one: DATABASE_URL
//     else the LITE default. Operator scripts and workers are untouched.
//
// The vitest globalSetup (test/vitestGlobalSetup.ts at the repo root) creates
// the test database if missing and applies THE SAME prisma/migrations via
// `prisma migrate deploy`, so test schema always matches live schema.

const LITE_HOST = 'localhost';
const LITE_PORT = 5439;
const LITE_USER = 'flowradar';
const LITE_PASSWORD = 'flowradar';
const LITE_DATABASE = 'flowradar';
const LITE_TEST_DATABASE = 'flowradar_test';

/** The live LITE default URL (fallback when no DATABASE_URL is set). */
export const LIVE_LITE_DATABASE_URL = `postgresql://${LITE_USER}:${LITE_PASSWORD}@${LITE_HOST}:${LITE_PORT}/${LITE_DATABASE}`;

/** The dedicated test database on the SAME embedded cluster. */
export const TEST_LITE_DATABASE_URL = `postgresql://${LITE_USER}:${LITE_PASSWORD}@${LITE_HOST}:${LITE_PORT}/${LITE_TEST_DATABASE}`;

/** Thrown when test-mode resolution would violate isolation. Fails closed. */
export class TestDbIsolationError extends Error {
  constructor(message: string) {
    super(`TEST/LIVE DB isolation violation — refusing to run: ${message}`);
    this.name = 'TestDbIsolationError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Canonical identity of a postgres URL: lowercased host, defaulted port, db name. */
function canonicalIdentity(url: string, what: string): { host: string; port: string; db: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TestDbIsolationError(`${what} is not a parsable URL`);
  }
  const db = parsed.pathname.replace(/^\//, '');
  if (!db) throw new TestDbIsolationError(`${what} has no database name`);
  return { host: parsed.hostname.toLowerCase(), port: parsed.port || '5432', db };
}

/**
 * THE resolution rule, pure over an injected env so the fail-closed branches
 * are unit-testable. `client.ts` calls this with the real process.env after
 * loading the root .env.
 */
export function resolveDatabaseUrlForEnv(env: NodeJS.ProcessEnv): string {
  const liveUrl = env.DATABASE_URL ?? LIVE_LITE_DATABASE_URL;

  // Not a test process: unchanged legacy behavior.
  if (!env.VITEST) return liveUrl;

  // Test process: NEVER consult DATABASE_URL for the target.
  const testUrl = env.TEST_DATABASE_URL ?? TEST_LITE_DATABASE_URL;
  const test = canonicalIdentity(testUrl, 'TEST_DATABASE_URL');
  if (!test.db.endsWith('_test')) {
    throw new TestDbIsolationError(
      `test database name "${test.db}" must end with "_test" (explicit test identity; live db names never qualify)`
    );
  }
  // Test databases are LOCAL by policy: a "_test"-suffixed database on a
  // remote host could be someone's production cluster — refuse (Codex Task-A
  // review). This also guarantees the globalSetup provisioner and the workers
  // are talking to the same local cluster.
  if (!LOCAL_HOSTS.has(test.host)) {
    throw new TestDbIsolationError(`test database host "${test.host}" is not local — tests only ever run against localhost`);
  }
  // Same-identity collision: compare CANONICAL identities (host lowercased,
  // port defaulted, db name), not raw strings — query params, credential
  // differences, or an explicit default port must not defeat the check.
  let live: { host: string; port: string; db: string } | null = null;
  try {
    live = canonicalIdentity(liveUrl, 'DATABASE_URL');
  } catch {
    live = null; // unparsable live URL cannot collide; test target is already validated
  }
  if (live && live.host === test.host && live.port === test.port && live.db === test.db) {
    throw new TestDbIsolationError('TEST_DATABASE_URL points at the same database as the live DATABASE_URL — set distinct identities');
  }
  return testUrl;
}
