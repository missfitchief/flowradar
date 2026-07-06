import type { NextConfig } from 'next';

// @flowradar/core, @flowradar/db, @flowradar/providers are workspace packages
// published as raw TypeScript (main/types point at src/*.ts, no build step) —
// transpilePackages tells Next's bundler to run them through its own
// TS/ESM pipeline instead of expecting pre-built JS. @flowradar/providers
// became a direct apps/web dependency in Task 16 (POST /api/alerts/test
// needs createTelegramSender) — the task-7 binding decision had already
// pre-added it here in transpilePackages ahead of that need.
//
// serverExternalPackages: '@prisma/client' ships native query-engine binaries
// that must NOT be bundled by webpack/Turbopack — Next needs to require() it
// natively at runtime in the Node.js server runtime instead.
//
// No extra `dotenv/config` import here: `@flowradar/db`'s own client.ts
// bootstraps DATABASE_URL from the repo-root .env (or a hardcoded LITE
// default) at import time regardless of caller — verified working from a
// server component with zero extra env plumbing in this task's boot check.
//
// No custom webpack() resolver override needed: the whole monorepo's
// tsconfig.base.json module resolution was switched NodeNext -> bundler
// (controller decision, Task 7) specifically so extensionless relative
// specifiers (e.g. `export * from './client'`) resolve directly under
// Next's default webpack resolver, without needing a `.js` extension in the
// source and without needing a resolve.extensionAlias workaround here.
const nextConfig: NextConfig = {
  transpilePackages: ['@flowradar/core', '@flowradar/db', '@flowradar/providers'],
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;
