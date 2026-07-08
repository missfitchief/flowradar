// FlowRadar — token-detail Confluence panel wiring test (Task E).
//
// apps/web ships no React/JSX render harness (vitest here has no JSX
// transform — see framingBanner.test.ts / tokenSocialSection.test.ts). Per
// that convention this is a Node-only source-text check proving the
// SHADOW-ONLY Confluence panel is (a) wired into the token page from real
// getTokenConfluence data and (b) implements the honest-absence +
// provider-claimed-labeling + conflict-aware + never-"safe" + no-secret
// behaviors the design doc requires. Files are read as raw text (importing
// .tsx errors under the Node transform), matching the sibling tests exactly.
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
  path.join(APP_ROOT, 'components', 'tokens', 'ConfluencePanel.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');

describe('token-detail Confluence panel (Task E)', () => {
  it('page fetches confluence via getTokenConfluence(prisma, token.id)', () => {
    expect(pageSrc).toMatch(/getTokenConfluence\(\s*prisma\s*,\s*token\.id\s*\)/);
  });

  it('page renders <ConfluencePanel /> and passes the confluence data', () => {
    expect(pageSrc).toMatch(/<ConfluencePanel\b/);
    expect(pageSrc).toMatch(/confluence=\{/);
  });

  it('panel is a server component (no client directive — read-only display)', () => {
    expect(compSrc).not.toMatch(/^['"]use client['"]/m);
  });

  it('panel renders all five confluence cards', () => {
    expect(compSrc).toMatch(/Liquidity Risk/);
    expect(compSrc).toMatch(/Holder Risk/);
    expect(compSrc).toMatch(/CLOBr/);
    expect(compSrc).toMatch(/GMGN/);
    expect(compSrc).toMatch(/AG Paper/);
  });

  it('panel renders the Social + Wallet + External overlap summary', () => {
    expect(compSrc).toMatch(/overlap/i);
  });

  it('panel labels shadow-only and not-part-of-FlowScore', () => {
    expect(compSrc).toMatch(/shadow-only/i);
    expect(compSrc).toMatch(/not part of FlowScore/i);
  });

  it('panel labels provider-claimed metrics distinctly from internal/computed', () => {
    expect(compSrc).toMatch(/provider-claimed/i);
  });

  it('panel renders unavailable/missing/stub states honestly and NEVER "safe"/"clean"', () => {
    // The absent/stub/plan-required states must be surfaced as unknown/unavailable.
    expect(compSrc).toMatch(/unavailable|unknown|not integrated|plan.?required/i);
    // Constraint 15: absence of data is NEVER a green light. The word "safe"/"clean"
    // as a verdict must not appear in the panel source.
    expect(compSrc).not.toMatch(/\b(safe|clean)\b/i);
  });

  it('panel is conflict-aware — surfaces source disagreement, not only confirmation', () => {
    expect(compSrc).toMatch(/disagree/i);
  });

  it('panel renders an honest empty state when there is no confluence at all', () => {
    expect(compSrc).toMatch(/No confluence/i);
  });

  it('panel never renders a resolved secret (env NAME only, never a value assignment)', () => {
    // apiKeyEnvName is a NAME; the panel must not interpolate process.env values.
    expect(compSrc).not.toMatch(/process\.env/);
  });
});
