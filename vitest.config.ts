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
          passWithNoTests: true
        }
      },
      {
        test: {
          name: 'providers',
          root: './packages/providers',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true
        }
      }
    ]
  }
});
