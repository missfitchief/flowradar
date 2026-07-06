import { defineConfig } from 'vitest/config';

// Vitest 4 replaced the vitest.workspace.ts file with a `projects` array on
// the root config (defineWorkspace/--workspace were removed). One project
// per package.json test suite so `npm run test` (vitest run) discovers
// tests wherever later tasks add them under packages/*/test.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true
        }
      },
      {
        test: {
          name: 'db',
          root: './packages/db',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
          // The db integration suite runs several whole-DB passes
          // (runEntityClustering, runProfitRotation, runSignalDetectionPass —
          // each does full-table scans/deletes, not scoped to a single
          // test's own address prefix) against ONE shared embedded-Postgres
          // instance (LITE mode, port 5439). Running test FILES within this
          // project concurrently (vitest's default) caused genuine lock
          // contention / connection-pool pressure once enough whole-DB-pass
          // files existed side by side (clustering.test.ts (which also carries the
          // Task 23 evidence-path cases), rotation.test.ts, signalDedupe.test.ts)
          // — observed as P2002 unique-constraint races and outright
          // testTimeout failures under the default 5000ms budget. Unit-style
          // packages (core/providers) don't touch a real DB and stay
          // parallel; only this project needs serialization.
          fileParallelism: false,
          testTimeout: 20000
        }
      },
      {
        test: {
          name: 'providers',
          root: './packages/providers',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true
        }
      },
      {
        test: {
          name: 'web',
          root: './apps/web',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true
        }
      }
    ]
  }
});
