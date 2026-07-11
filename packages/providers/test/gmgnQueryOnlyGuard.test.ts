// FlowRadar — GMGN query-only enforcement (design doc §Module D "Enforcement",
// global constraint 8/20). This is a source-text grep guard: the GMGN
// confluence adapter must reference ZERO swap/order/execution/private-key/
// wallet-management endpoints. If a future edit adds any such capability, this
// test fails loudly. Reads the actual file off disk (not the compiled module).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GMGN_SRC = join(__dirname, '..', 'src', 'confluence', 'gmgn.ts');

// Forbidden capability substrings (case-insensitive). Kept as split fragments
// in some entries so this guard file itself does not contain a full forbidden
// token that would false-positive a naive scan of the test dir.
const FORBIDDEN = [
  'swap',
  'order',
  'execute',
  'execution',
  'private' + 'key',
  'privatekey',
  'private_key',
  'wallet' + 'management',
  'signtransaction',
  'sign_transaction',
  'sendtransaction'
];

describe('GMGN confluence adapter — query-only enforcement (grep guard)', () => {
  const src = readFileSync(GMGN_SRC, 'utf8').toLowerCase();

  for (const term of FORBIDDEN) {
    it(`references zero "${term}" endpoints/capabilities`, () => {
      expect(src.includes(term)).toBe(false);
    });
  }

  it('the file actually exists and defines createGmgnProvider (guard is not vacuous)', () => {
    expect(src).toContain('creategmgnprovider');
  });
});

// ---------------------------------------------------------------------------
// Repo-wide GMGN capability guard (overnight GMGN policy item 8). gmgn-cli is
// now installed on operator machines and exposes swap / multi-swap / order /
// cooking / wallet-management / key subcommands. Any FUTURE FlowRadar code
// that talks to GMGN (CLI shell-out or API) must stay in the query-only
// families — this guard scans EVERY gmgn-mentioning source file in the
// integration surface (packages/providers, packages/db, apps/worker src trees)
// for forbidden CAPABILITY tokens. Tokens are strict (multi-swap, cooking,
// GMGN_PRIVATE_KEY, sign_transaction, wallet_management, and explicit
// forbidden `gmgn-cli <cmd>` invocations) so innocent prose like "swap the
// parser" in unrelated comments cannot false-positive; the single-file guard
// above stays the stricter gate for the confluence adapter itself.
// ---------------------------------------------------------------------------

import { globSync } from 'node:fs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
// Full executable surface: package/app sources (ts+tsx), Next app+components,
// repo scripts (ts/js/mjs), worker jobs. Test dirs are excluded (this guard
// and the CLI-probe docs legitimately NAME the forbidden families).
const SURFACE_GLOBS = [
  'packages/*/src/**/*.ts',
  'packages/*/src/**/*.tsx',
  'apps/*/src/**/*.ts',
  'apps/web/app/**/*.ts',
  'apps/web/app/**/*.tsx',
  'apps/web/components/**/*.ts',
  'apps/web/components/**/*.tsx',
  'scripts/**/*.ts',
  'scripts/**/*.js',
  'scripts/**/*.mjs'
];
const CAPABILITY_TOKENS = [
  'multi-swap',
  'multiswap',
  'cooking',
  'gmgn_' + 'private_key',
  'sign' + 'transaction',
  'sign_' + 'transaction',
  'send' + 'transaction',
  'send_' + 'transaction',
  'wallet' + 'management',
  'wallet_' + 'management'
];
// Forbidden gmgn-cli subcommand invocations: shell-string form AND the
// spawn/execFile argv form (`'gmgn-cli', ['swap', ...]`). Bare 'swap'/'order'
// tokens repo-wide would false-positive on orderBy/"swap the parser" prose —
// those stay enforced by the stricter single-file guard above; known residual
// limit: a grep guard cannot catch runtime string construction.
const FORBIDDEN_SUBCOMMANDS = ['swap', 'multi-swap', 'order', 'cooking', 'key', 'wallet', 'config'];
// ANY line mentioning gmgn-cli (incl. gmgn-cli.cmd / .exe / flags before the
// subcommand) that also carries a forbidden subcommand WORD is an offender —
// broader than exact invocation shapes, so option reordering can't slip by.
const CLI_LINE_COOCCURRENCE = new RegExp(
  `gmgn-cli[^\\n]*\\b(${FORBIDDEN_SUBCOMMANDS.join('|').replace(/-/g, '\\-')})\\b`,
  'i'
);
// Literal GMGN API paths for execution families inside string literals.
const API_PATH_LITERAL = /['"`][^'"`\n]*\/(swap|multi-swap|order|orders|cooking)s?\b[^'"`\n]*['"`]/i;

// Files that are themselves GUARDS and legitimately NAME forbidden tokens in
// their own forbidden-lists. Nothing else may be added here without review.
const GUARD_ALLOWLIST = new Set([
  'scripts/confluence-gate.mjs'.replace(/\//g, sep),
  // The runtime allowlist itself NAMES forbidden families in its rejection
  // logic/comments — it is a guard, like confluence-gate.mjs. Its own tests
  // (gmgnAllowlist.test.ts) prove those families are REJECTED, not invoked.
  'packages/providers/src/gmgn/allowlist.ts'.replace(/\//g, sep)
]);

describe('repo-wide GMGN capability guard (grep guard)', () => {
  const gmgnFiles = SURFACE_GLOBS.flatMap((g) => globSync(g, { cwd: REPO_ROOT }))
    .filter((f) => !GUARD_ALLOWLIST.has(f))
    .map((f) => join(REPO_ROOT, f))
    .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes('gmgn'));

  it('finds the gmgn integration surface (guard is not vacuous)', () => {
    expect(gmgnFiles.length).toBeGreaterThan(0);
  });

  it('no gmgn-mentioning source file references a forbidden capability, CLI invocation, or API path', () => {
    const offenders: { file: string; token: string }[] = [];
    for (const file of gmgnFiles) {
      const content = readFileSync(file, 'utf8').toLowerCase();
      for (const token of CAPABILITY_TOKENS) {
        if (content.includes(token)) offenders.push({ file, token });
      }
      for (const line of content.split('\n')) {
        if (CLI_LINE_COOCCURRENCE.test(line)) offenders.push({ file, token: `cli line: ${line.trim().slice(0, 60)}` });
        if (API_PATH_LITERAL.test(line)) offenders.push({ file, token: `api path: ${line.trim().slice(0, 60)}` });
      }
    }
    expect(offenders).toEqual([]);
  });

  // The choke-point file is excluded from the token grep above (it legitimately
  // names forbidden families in its rejection logic), so this dedicated guard
  // ensures excluding it did NOT open a blind spot: allowlist.ts may spawn a
  // child process EXACTLY ONCE (the single validated execFile in runGmgnCli),
  // and only via execFile (never exec/spawn/shell). A second runner or a raw
  // exec/spawn added there — the way a forbidden invocation would sneak in —
  // fails this test (Codex Task-1 #2).
  it('the excluded allowlist.ts has EXACTLY one child-process call, via execFile only', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages/providers/src/gmgn/allowlist.ts'), 'utf8');
    const execFileCalls = (src.match(/\bexecFile\s*\(/g) ?? []).length;
    // ALL other child_process spawn forms (incl. *Sync variants) are
    // prohibited (Codex Task-1 #2 — execFileSync was missing).
    const otherSpawns = (src.match(/\b(exec|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/g) ?? []).length;
    expect(execFileCalls).toBe(1);
    expect(otherSpawns).toBe(0);
    // The child_process import must expose ONLY execFile — an alias like
    // `import { exec as run }` or `const run = execFile` would defeat the
    // regexes above, so pin the import shape and forbid re-binding.
    expect(src).toMatch(/import\s*\{\s*execFile\s*\}\s*from\s*'node:child_process'/);
    expect(src).not.toMatch(/child_process['"]\s*\)?;?[\s\S]*\bexec\b\s+as\b/);
    expect(src).not.toMatch(/=\s*execFile\b(?!\s*\()/); // `const x = execFile` (alias), not a call
    // The single call must be guarded: the validation precedes execFile.
    expect(src.indexOf('assertGmgnCommandAllowed(snapshot)')).toBeGreaterThan(-1);
    expect(src.indexOf('assertGmgnCommandAllowed(snapshot)')).toBeLessThan(src.indexOf('execFile('));
  });
});
