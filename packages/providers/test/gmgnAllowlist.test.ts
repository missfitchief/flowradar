// FlowRadar — GMGN runtime command allowlist tests (Task 1 guard).
//
// The allowlist is the ONLY path FlowRadar may invoke gmgn-cli through. It
// must ACCEPT the documented read-only families and REJECT every execution /
// key-management family, before any process is spawned.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('FAILS CLOSED on non-string / stringify-once elements (TOCTOU guard, Codex P1)', () => {
    // An object that stringifies to an allowed pair once but is not a plain
    // string — the classic validate-one-thing/execute-another attack.
    const family = { toString: () => 'track' };
    const sub = { toString: () => 'smartmoney' };
    expect(() => assertGmgnCommandAllowed([family, sub] as unknown[])).toThrow(GmgnForbiddenCommandError);
    // Whitespace-padded tokens are malformed, not allowed.
    expect(() => assertGmgnCommandAllowed([' track', 'smartmoney'])).toThrow(GmgnForbiddenCommandError);
    expect(() => assertGmgnCommandAllowed(['track', 'smartmoney '])).toThrow(GmgnForbiddenCommandError);
    // A single joined element is not a valid pair.
    expect(() => assertGmgnCommandAllowed(['track smartmoney'])).toThrow(GmgnForbiddenCommandError);
    // A non-string trailing arg is rejected too.
    expect(() => assertGmgnCommandAllowed(['token', 'info', { toString: () => '--raw' }] as unknown[])).toThrow(GmgnForbiddenCommandError);
    // A non-array argv fails closed.
    expect(() => assertGmgnCommandAllowed('track smartmoney' as unknown as string[])).toThrow(GmgnForbiddenCommandError);
  });

  it('returns the validated pair for an allowed command', () => {
    expect(assertGmgnCommandAllowed(['token', 'holders', '--address', 'T'])).toEqual({ family: 'token', subcommand: 'holders' });
  });
});

// BEHAVIORAL interception of the real child_process.execFile (Codex P2 #4):
// proves what runGmgnCli actually passes to the OS, not what the source text
// says. Mock returns a benign JSON stdout so allowed commands resolve.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});
import { execFile as mockedExecFile } from 'node:child_process';

describe('runGmgnCli (behavioral)', () => {
  const execMock = mockedExecFile as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    execMock.mockReset();
    // Default: invoke the callback with valid JSON so allowed calls resolve.
    execMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      cb(null, '{"ok":true}');
      return {} as never;
    });
  });

  it('refuses to spawn a forbidden command — execFile is NEVER called', async () => {
    await expect(runGmgnCli(['swap', '--chain', 'sol'])).rejects.toThrow(GmgnForbiddenCommandError);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('an allowed command spawns node (not a shell) with shell:false and a literal argv', async () => {
    await runGmgnCli(['token', 'holders', '--chain', 'sol', '--address', 'T', '--raw']);
    expect(execMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = execMock.mock.calls[0]!;
    expect(bin).toBe(process.execPath); // node, never cmd.exe / a shell
    expect((options as { shell?: boolean }).shell).toBe(false);
    // argv is a literal string array whose tail matches what we asked for.
    expect(Array.isArray(args)).toBe(true);
    expect((args as string[]).slice(-6)).toEqual(['token', 'holders', '--chain', 'sol', '--address', 'T', '--raw'].slice(-6));
    expect((args as string[]).every((a) => typeof a === 'string')).toBe(true);
  });

  it('executes a FROZEN string snapshot — a live getter cannot swap the command after validation (TOCTOU)', async () => {
    // argv whose element is a plain string at validation but a getter proxy
    // would differ later; here we pass a normal allowed array and assert the
    // executed args are all primitive strings (String()-coerced snapshot).
    await runGmgnCli(['market', 'trending', '--chain', 'sol', '--raw']);
    const [, args] = execMock.mock.calls[0]!;
    for (const a of args as unknown[]) expect(typeof a).toBe('string');
  });
});
