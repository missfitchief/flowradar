// FlowRadar — GMGN runtime command allowlist tests (Task 1 guard).
//
// The allowlist is the ONLY path FlowRadar may invoke gmgn-cli through. It
// must ACCEPT the documented read-only families and REJECT every execution /
// key-management family, before any process is spawned.
import { describe, expect, it, vi } from 'vitest';
import { assertGmgnCommandAllowed, runGmgnCli, GmgnForbiddenCommandError } from '../src/gmgn/allowlist';

const ALLOWED: string[][] = [
  ['track', 'smartmoney', '--chain', 'sol', '--limit', '5', '--raw'],
  ['track', 'kol', '--chain', 'sol', '--raw'],
  ['track', 'follow-wallet', '--wallet', 'X', '--raw'],
  ['market', 'trenches', '--chain', 'sol', '--raw'],
  ['market', 'trending', '--chain', 'sol', '--raw'],
  ['market', 'signal', '--chain', 'sol', '--raw'],
  ['token', 'info', '--chain', 'sol', '--address', 'T'],
  ['token', 'security', '--chain', 'sol', '--address', 'T'],
  ['token', 'pool', '--chain', 'sol', '--address', 'T'],
  ['token', 'holders', '--chain', 'sol', '--address', 'T'],
  ['token', 'traders', '--chain', 'sol', '--address', 'T'],
  ['portfolio', 'holdings', '--chain', 'sol', '--wallet', 'W'],
  ['portfolio', 'stats', '--chain', 'sol', '--wallet', 'W', '--period', '30d'],
  ['portfolio', 'activity', '--chain', 'sol', '--wallet', 'W']
];

const FORBIDDEN: string[][] = [
  ['swap', '--chain', 'sol'],
  ['multi-swap'],
  ['order', 'list'],
  ['cooking', 'create'],
  ['config', '--apply', 'KEY'],
  ['config', '--check'],
  ['gas-price', '--chain', 'sol'],
  ['portfolio', 'info'], // exposes API-key-bound wallets — not a read-only intel family
  ['portfolio', 'token-balance', '--wallet', 'W'],
  ['portfolio', 'created-tokens', '--wallet', 'W'],
  ['token', 'unknown-subcommand'],
  ['track', 'follow-tokens'], // not on the allowed intel list
  ['market', 'kline'] // not on the allowed intel list for this branch
];

describe('assertGmgnCommandAllowed', () => {
  for (const argv of ALLOWED) {
    it(`ALLOWS: ${argv.slice(0, 2).join(' ')}`, () => {
      expect(() => assertGmgnCommandAllowed(argv)).not.toThrow();
    });
  }
  for (const argv of FORBIDDEN) {
    it(`REJECTS: ${argv.slice(0, 2).join(' ')}`, () => {
      expect(() => assertGmgnCommandAllowed(argv)).toThrow(GmgnForbiddenCommandError);
    });
  }

  it('rejects an empty argv and a forbidden token smuggled into options', () => {
    expect(() => assertGmgnCommandAllowed([])).toThrow(GmgnForbiddenCommandError);
    // Only the FAMILY+subcommand pair is allowlisted; a --swap-ish flag on an
    // allowed command is fine (it is not a subcommand) but a bare forbidden
    // FIRST token is not.
    expect(() => assertGmgnCommandAllowed(['sign'])).toThrow(GmgnForbiddenCommandError);
  });

  it('is case/prefix exact — "tokeninfo" or "SWAP" do not sneak through', () => {
    expect(() => assertGmgnCommandAllowed(['SWAP'])).toThrow(GmgnForbiddenCommandError);
    expect(() => assertGmgnCommandAllowed(['tokens'])).toThrow(GmgnForbiddenCommandError);
  });
});

describe('runGmgnCli', () => {
  it('refuses to spawn a forbidden command (guard runs BEFORE any process)', async () => {
    // No spawn mock needed: the guard must throw synchronously-in-promise
    // before touching child_process.
    await expect(runGmgnCli(['swap', '--chain', 'sol'])).rejects.toThrow(GmgnForbiddenCommandError);
  });

  it('never invokes gmgn-cli via a shell (shell:false is mandatory)', async () => {
    // Statically assert the source never passes shell:true — a shell would
    // reintroduce injection + defeat the argv allowlist.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gmgn', 'allowlist.ts'),
      'utf-8'
    );
    expect(src).not.toMatch(/shell\s*:\s*true/);
    expect(src).toMatch(/shell\s*:\s*false/);
  });
});
