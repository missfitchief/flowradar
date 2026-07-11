// FlowRadar — static guard: no bare Prisma client in test code (Task A).
//
// The vitest test-DB redirect lives in packages/db/src/testDb.ts and only
// governs URL resolution that flows THROUGH resolveDatabaseUrl (the shared
// singleton + withGlobalJobLock). A ZERO-ARGUMENT Prisma client construction
// resolves env(DATABASE_URL) by itself — root .env carries the LIVE url — and
// silently writes test fixtures into the live DB (the original leaked-fixture
// incident's second door, found in confluenceQueries.test.ts). This grep-style
// guard (same pattern as dunecandidateTrustBoundary/gmgnQueryOnlyGuard) keeps
// that door closed: test files must use the shared singleton, or construct a
// client with an EXPLICIT datasources url (e.g. the isolation test's pinned
// read-only live client — a deliberate, visible choice). The forbidden
// pattern is assembled from fragments so this guard file cannot match itself.
import { describe, expect, it } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const TEST_GLOBS = [
  'packages/*/test/**/*.ts',
  'apps/*/test/**/*.ts',
  'test/**/*.ts' // repo-root test/ (vitest globalSetup lives here)
];

// Assembled from fragments so THIS file never contains the forbidden token.
const BARE_CLIENT = new RegExp('new\\s+Prisma' + 'Client\\(\\s*\\)');

describe('DB test-client guard (static)', () => {
  it('no test file constructs a zero-argument Prisma client (use the singleton or an explicit URL)', () => {
    const files = TEST_GLOBS.flatMap((g) => globSync(g, { cwd: REPO_ROOT })).map((f) => path.join(REPO_ROOT, f));
    expect(files.length).toBeGreaterThan(0);
    const offenders: { file: string; line: number }[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        // Bare = no constructor argument at all. A construction WITH an
        // explicit datasources url is allowed (visible choice).
        if (BARE_CLIENT.test(line)) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: i + 1 });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
