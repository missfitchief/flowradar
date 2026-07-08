// FlowRadar — token-detail "Social mentions" section wiring test (Task F).
//
// apps/web ships no React/JSX render harness (vitest here has no JSX
// transform — see apps/web/test/framingBanner.test.ts header). Per that
// established convention this is a Node-only source-text check proving the
// shadow-only social section is (a) wired into the token page from real data
// and (b) implements the spam-filter + unlinked-safe + empty-state behaviors
// required by the spec (§8 token detail social section, §10 graceful skips).
// Files are read as raw text (importing .tsx would error on JSX under the
// Node transform), matching framingBanner.test.ts exactly.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

const pageSrc = readFileSync(
  path.join(APP_ROOT, 'app', 'tokens', '[id]', 'page.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');
const compSrc = readFileSync(
  path.join(APP_ROOT, 'components', 'tokens', 'SocialSection.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');

describe('token-detail Social mentions section (Task F)', () => {
  it('page fetches this token\'s mentions via getTokenSocialMentions', () => {
    expect(pageSrc).toMatch(/getTokenSocialMentions\(\s*prisma\s*,\s*token\.id\s*\)/);
  });

  it('page computes mention velocity via computeMentionVelocity from real settings windows', () => {
    expect(pageSrc).toMatch(/computeMentionVelocity\(/);
    // windows + spam cap come from settings, not hardcoded literals inline.
    expect(pageSrc).toMatch(/velocityWindowsMin/);
  });

  it('velocity spam cutoff = uiHideThreshold - 1 (aligned with /social + the feed collapse; M1)', () => {
    // The feed greys spamScore >= uiHideThreshold, so velocity must keep
    // spamScore <= uiHideThreshold - 1 to count EXACTLY the shown mentions —
    // matching apps/web/app/social/page.tsx and avoiding the off-by-one where a
    // mention scored exactly at the threshold is greyed yet still counted.
    expect(pageSrc).toMatch(/spamMaxScore:\s*socialCfg\.spam\.uiHideThreshold\s*-\s*1/);
  });

  it('page renders <SocialSection /> and passes uiHideThreshold', () => {
    expect(pageSrc).toMatch(/<SocialSection\b/);
    expect(pageSrc).toMatch(/uiHideThreshold=\{/);
  });

  it('page does NOT touch FlowScore / signal / wallet-scoring in this section (shadow-only)', () => {
    // The social block adds no scoring writes — no assignment to flow/signal fields.
    expect(compSrc).not.toMatch(/flowScore|signalStatus\s*=|walletScore\s*=/i);
  });

  it('SocialSection greys/collapses high-spam mentions (>= uiHideThreshold), never drops silently', () => {
    // A comparison against the threshold must exist (spam is filtered for
    // DISPLAY, not deleted — spec §4/§8).
    expect(compSrc).toMatch(/spamScore\s*>=\s*uiHideThreshold/);
  });

  it('SocialSection renders an "unlinked" affordance for mentions with no tokenId (graceful skip)', () => {
    expect(compSrc).toMatch(/unlinked/i);
    expect(compSrc).toMatch(/tokenId/);
  });

  it('SocialSection renders an honest empty state when there are zero mentions', () => {
    expect(compSrc).toMatch(/mentions\.length === 0/);
    expect(compSrc).toMatch(/No social mentions/i);
  });

  it('SocialSection has no client directive — it is a server component (read-only display)', () => {
    expect(compSrc).not.toMatch(/^['"]use client['"]/m);
  });
});
