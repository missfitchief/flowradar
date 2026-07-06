// FlowRadar — hard-framing banner presence test (Task 42 brief: "This copy is
// asserted in a component test (string presence), not just written once").
//
// apps/web has no React-rendering test infra (no jsdom/@testing-library —
// see lib/format.ts's own "no unit tests ship... verification is the
// preview-snapshot boot check instead" precedent, and this task's binding
// decision 7 forbids new deps). Rather than add a new rendering stack for a
// single string-presence assertion, this is a plain Node-environment source
// check: both page files must actually render <FramingBanner /> (not just
// import it unused), and FramingBanner's own exported text constant must
// equal the EXACT binding copy — so a future edit that silently drifts the
// copy, or that removes the banner from one page while leaving it on the
// other, fails this test. Full page rendering (routing, data fetching,
// hydration) is covered by the boot-check preview snapshot per this app's
// existing convention.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately NOT importing FramingBanner.tsx directly — this project's
// vitest config has no React/JSX transform plugin (this is a Node-only
// source-text check, not a rendering test; see this file's header), and
// importing a .tsx file through plain esbuild/vite transform errors on JSX
// syntax. Reading every file as raw text sidesteps that entirely while still
// proving the same thing: the exported constant and both pages' usage of it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

const EXPECTED_TEXT =
  'Mock data proves the code path only. Only historical replay and shadow-mode results on real market data validate signal quality.';

describe('FramingBanner — hard-framing copy (Spec §5c binding requirement)', () => {
  it('FramingBanner.tsx exports the exact binding copy verbatim', () => {
    // Normalize CRLF -> LF before the byte-exact check: the committed blob is
    // LF (CI/Linux checkouts pass as-is), but on a Windows autocrlf=true clone
    // the working tree is smudged to CRLF, which would break the embedded `\n`
    // in the expected substring. The assertion below is unchanged in meaning —
    // the exact prefix + verbatim copy must still be present — just made
    // independent of the checkout's line-ending policy.
    const source = readFileSync(
      path.join(APP_ROOT, 'components', 'backtest', 'FramingBanner.tsx'),
      'utf-8',
    ).replace(/\r\n/g, '\n');
    expect(source).toContain(`export const FRAMING_BANNER_TEXT =\n  '${EXPECTED_TEXT}';`);
  });

  it('renders on /backtest (app/backtest/page.tsx uses <FramingBanner />)', () => {
    const source = readFileSync(path.join(APP_ROOT, 'app', 'backtest', 'page.tsx'), 'utf-8');
    expect(source).toMatch(/<FramingBanner\s*\/>/);
  });

  it('renders on /shadow (app/shadow/page.tsx uses <FramingBanner />)', () => {
    const source = readFileSync(path.join(APP_ROOT, 'app', 'shadow', 'page.tsx'), 'utf-8');
    expect(source).toMatch(/<FramingBanner\s*\/>/);
  });
});
