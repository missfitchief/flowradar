// Single import point for the Prisma client in apps/web — every page/server
// component imports `prisma` from here, never directly from `@flowradar/db`,
// so the DB access surface for the whole app is this one file.
//
// `@flowradar/db`'s own client.ts bootstraps DATABASE_URL from the repo-root
// .env (falling back to the LITE embedded-postgres default at
// localhost:5439) the moment it's imported — no extra env plumbing needed
// here (verified against the LITE-mode seeded DB during this task's boot
// check).
export { prisma } from '@flowradar/db';
