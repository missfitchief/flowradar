// FlowRadar — /social page + /api/social/sources source-text tests (Task E).
//
// apps/web has no Next.js-runtime/JSX test harness (no jsdom/@testing-library,
// no route-handler mocking convention anywhere in this codebase — see
// framingBanner.test.ts's own header for why). Consistent with that
// established pattern, these are plain Node source-text checks that the
// route/page enforce the shadow-only + name-only + honest-empty-state
// contract. Full page rendering is covered by the boot-check preview
// snapshot (Task G), same convention as every other DB-backed page.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const read = (...p: string[]) => readFileSync(path.join(APP_ROOT, ...p), 'utf-8').replace(/\r\n/g, '\n');

describe('/api/social/sources route (Task E — Zod, name-only key, shadow-only)', () => {
  const src = read('app', 'api', 'social', 'sources', 'route.ts');

  it('exports POST, PATCH and DELETE handlers', () => {
    expect(src).toMatch(/export async function POST\s*\(/);
    expect(src).toMatch(/export async function PATCH\s*\(/);
    expect(src).toMatch(/export async function DELETE\s*\(/);
  });

  it('validates the body with Zod (parses a schema, not raw body)', () => {
    expect(src).toMatch(/z\.object\(/);
    expect(src).toMatch(/\.parse\(/);
  });

  it('treats apiKeyEnvName as a NAME only — never reads process.env[...] for its value and never stores a secret value', () => {
    // The route must not resolve the env VALUE of the submitted name.
    expect(src).not.toMatch(/process\.env\[[^\]]*apiKeyEnvName/);
    // A plain field named apiKeyEnvName is expected (the NAME), so its
    // presence as a schema field is fine; the guard above is the real check.
    expect(src).toMatch(/apiKeyEnvName/);
  });

  it('never creates Alert rows or touches CandidateWallet/FlowScore (shadow-only, constraint 3/4/7)', () => {
    expect(src).not.toMatch(/\.alert\./);
    expect(src).not.toMatch(/candidateWallet/i);
    expect(src).not.toMatch(/flowScore/i);
  });
});

describe('/social page (Task E — empty state, spam collapse, force-dynamic, wiring)', () => {
  const page = read('app', 'social', 'page.tsx');
  const manager = read('app', 'social', 'SourceManager.tsx');
  const nav = read('components', 'layout', 'sidebar-nav.tsx');

  it('page is force-dynamic (DB-backed, per-request)', () => {
    expect(page).toMatch(/export const dynamic = 'force-dynamic';/);
  });

  it('renders an honest empty state when there are no sources or no mentions', () => {
    // Both the zero-sources and zero-mentions branches must exist.
    expect(page).toMatch(/sources\.length === 0/);
    expect(page).toMatch(/mentions\.length === 0/);
    // A visible "add a source" affordance in the empty state.
    expect(page).toMatch(/Add (a |your first )?source/i);
  });

  it('collapses/greys high-spam mentions at or above the settings uiHideThreshold (spec §4/§8)', () => {
    // The threshold must come from settings, not a magic literal.
    expect(page).toMatch(/uiHideThreshold/);
    // A comparison of a mention spamScore against that threshold.
    expect(page).toMatch(/spamScore\s*>=\s*uiHideThreshold/);
  });

  it('renders the four required panels: mentions feed, velocity, wallet-signal overlap, manage-sources', () => {
    expect(page).toMatch(/Recent mentions/i);
    expect(page).toMatch(/velocity/i);
    // wallet-signal overlap uses the getSocialSignalOverlap helper.
    expect(page).toMatch(/getSocialSignalOverlap/);
    expect(page).toMatch(/<SourceManager/);
    // source health surfaced via getSocialSourceHealth + status mode.
    expect(page).toMatch(/getSocialSourceHealth/);
    expect(page).toMatch(/getSocialSourceStatuses/);
  });

  it('page reads mentions/velocity/overlap via the Task E DB helpers and velocity via core', () => {
    expect(page).toMatch(/getRecentMentions/);
    expect(page).toMatch(/computeMentionVelocity/);
  });

  it('SourceManager is a client component that POST/PATCH/DELETEs /api/social/sources and refreshes', () => {
    expect(manager).toMatch(/^'use client';/m);
    expect(manager).toMatch(/\/api\/social\/sources/);
    expect(manager).toMatch(/method:\s*'POST'/);
    expect(manager).toMatch(/method:\s*'PATCH'/);
    expect(manager).toMatch(/method:\s*'DELETE'/);
    expect(manager).toMatch(/router\.refresh\(\)/);
  });

  it('sidebar nav includes a Social link to /social', () => {
    expect(nav).toMatch(/\{ label: 'Social', href: '\/social' \}/);
  });
});

describe('token detail social section (Task G gate)', () => {
  const tokenPage = read('app', 'tokens', '[id]', 'page.tsx');

  it('token detail page renders <SocialSection /> (shadow-only social mentions)', () => {
    expect(tokenPage).toMatch(/<SocialSection\b/);
  });

  it("SocialSection reads this token's mentions + velocity (shadow-only, read-only)", () => {
    const section = read('components', 'tokens', 'SocialSection.tsx');
    expect(section).toMatch(/mentions/);
    expect(section).toMatch(/velocity/);
  });
});
