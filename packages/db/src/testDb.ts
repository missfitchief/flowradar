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

/** The database name (last path segment) of a postgres URL; throws on garbage. */
function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TestDbIsolationError(`TEST_DATABASE_URL is not a parsable URL`);
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) throw new TestDbIsolationError('test database URL has no database name');
  return name;
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
  const testDb = databaseNameOf(testUrl);
  if (!testDb.endsWith('_test')) {
    throw new TestDbIsolationError(
      `test database name "${testDb}" must end with "_test" (explicit test identity; live db names never qualify)`
    );
  }
  // Same-identity collision: if the ambient live URL and the test URL point
  // at the same database, live work and tests would share a DB — refuse.
  if (testUrl === liveUrl) {
    throw new TestDbIsolationError('TEST_DATABASE_URL equals the live DATABASE_URL (same database) — set distinct identities');
  }
  return testUrl;
}
