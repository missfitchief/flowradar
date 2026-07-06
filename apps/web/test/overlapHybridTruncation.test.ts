// FlowRadar — hybrid overlap truncation-flag test (Task 38 review fix,
// IMPORTANT 2). apps/web has no Next.js-runtime/JSX test harness (no
// jsdom/@testing-library, no route-handler mocking convention anywhere in
// this codebase — see apps/web/test/framingBanner.test.ts's own header for
// why: "no unit tests ship... verification is the preview-snapshot boot
// check instead"). Importing route.ts directly here would need next/server +
// @/lib/db + a live Prisma client mocked from scratch, which no existing web
// test does. Consistent with framingBanner.test.ts's established pattern,
// this is a plain Node source-text check that the hybrid branch's
// `truncated` computation is a genuine OR of both child legs' own truncated
// flags — NOT the hardcoded `false` the review flagged (route.ts previously
// computed `truncated = false // recomputed below`, and never recomputed
// it). The end-to-end "hybrid with a truncated dune leg ⇒ warning shows" is
// additionally verified live against the running app (see task-38-report.md
// Fix report's boot-check excerpt).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

describe('hybrid overlap search — truncated flag (Task 38 review fix)', () => {
  it('route.ts computes hybrid truncated as localTruncated || duneTruncated, not a hardcoded false', () => {
    const source = readFileSync(path.join(APP_ROOT, 'app', 'api', 'overlap', 'route.ts'), 'utf-8');

    // The old bug's exact hardcoded-false pattern must be gone.
    expect(source).not.toMatch(/truncated\s*=\s*false\s*\/\/\s*recomputed below/);

    // Each child leg's OWN truncated flag must be read from its returned
    // result (localResult.truncated / duneResult.truncated), guarded by
    // that leg having actually run to 'done' — a failed leg has no
    // meaningful truncated value.
    expect(source).toMatch(/localTruncated\s*=\s*localResult\.status === 'done' && localResult\.truncated/);
    expect(source).toMatch(/duneTruncated\s*=\s*duneResult\.status === 'done' && duneResult\.truncated/);

    // The final flag persisted onto the hybrid TokenOverlapSearch row must
    // be the OR of both legs.
    expect(source).toMatch(/const truncated = localTruncated \|\| duneTruncated;/);

    // And it must actually be threaded into the persisted hybridSearch row
    // (not computed and then discarded).
    expect(source).toMatch(/truncated,\s*\n\s*candidatesCreated,/);
  });

  it('runLocalOverlapSearch/runTokenOverlapSearch both expose a `truncated` field the hybrid branch can read', () => {
    const localSource = readFileSync(
      path.join(APP_ROOT, '..', '..', 'packages', 'db', 'src', 'dune', 'localOverlap.ts'),
      'utf-8'
    );
    const duneSource = readFileSync(
      path.join(APP_ROOT, '..', '..', 'packages', 'db', 'src', 'dune', 'duneOverlap.ts'),
      'utf-8'
    );
    expect(localSource).toMatch(/export interface LocalOverlapSearchResult \{[\s\S]*?truncated: boolean;/);
    expect(duneSource).toMatch(/export interface TokenOverlapSearchResult \{[\s\S]*?truncated: boolean;/);
  });
});
