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
const CLIENT_CTOR = new RegExp('new\\s+Prisma' + 'Client\\s*\\(');
// How many lines after the constructor may carry the `datasources` override
// (multiline construction). Wider than any real construction in this repo.
const CTOR_WINDOW = 6;

describe('DB test-client guard (static)', () => {
  it('every Prisma client constructed in a test file passes an explicit datasources url (no schema-env resolution)', () => {
    const files = TEST_GLOBS.flatMap((g) => globSync(g, { cwd: REPO_ROOT })).map((f) => path.join(REPO_ROOT, f));
    expect(files.length).toBeGreaterThan(0);
    const offenders: { file: string; line: number }[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (!CLIENT_CTOR.test(line)) return;
        // A construction is allowed ONLY when `datasources` appears within
        // its window — zero-arg, `{}`, logging-only, and multiline variants
        // without an explicit url all fall back to schema env(DATABASE_URL)
        // (root .env = LIVE url) and are forbidden (Codex Task-A review).
        const window = lines.slice(i, i + 1 + CTOR_WINDOW).join('\n');
        if (!/datasources/.test(window)) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: i + 1 });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
