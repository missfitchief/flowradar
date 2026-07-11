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

  it('a hostile Symbol.species cannot produce a value-swapping snapshot (TOCTOU, Codex P1 round 3)', async () => {
    // Subclass whose species is a Proxy-returning constructor: if runGmgnCli
    // used slice()/species-aware copying, the "copy" could still swap values.
    class Evil extends Array {
      static get [Symbol.species]() {
        return function (this: unknown) {
          const reads: Record<number, number> = {};
          return new Proxy([], {
            get(t, p, r) {
              if (typeof p === 'string' && /^\d+$/.test(p)) {
                const i = Number(p);
                reads[i] = (reads[i] ?? 0) + 1;
                if (i === 0) return reads[i] === 1 ? 'token' : 'swap';
                if (i === 1) return reads[i] === 1 ? 'holders' : 'swap';
              }
              if (p === 'length') return 2;
              return Reflect.get(t, p, r);
            }
          });
        } as unknown as ArrayConstructor;
      }
    }
    const evil = Evil.from(['token', 'holders']) as unknown as string[];
    // Whatever the species does, execFile must never receive 'swap'.
    try {
      await runGmgnCli(evil);
    } catch { /* rejection is an acceptable outcome */ }
    if (execMock.mock.calls.length > 0) {
      const [, args] = execMock.mock.calls[0]!;
      expect((args as string[]).includes('swap')).toBe(false);
    }
  });

  it('a Proxy that swaps values between reads cannot execute a different command (TOCTOU, Codex P1)', async () => {
    // The attack: an index returns an allowed value on the FIRST read and a
    // forbidden one on a LATER read. runGmgnCli must snapshot each index once,
    // validate that snapshot, and exec the same snapshot — so the attack
    // either is rejected or executes ONLY the first-read values.
    const reads: Record<number, number> = {};
    const evil = new Proxy(['x', 'x', 'x', 'x'], {
      get(target, prop, recv) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const i = Number(prop);
          reads[i] = (reads[i] ?? 0) + 1;
          // index 0: 'token' then 'swap'; index 1: 'holders' then '--x'
          if (i === 0) return reads[i] === 1 ? 'token' : 'swap';
          if (i === 1) return reads[i] === 1 ? 'holders' : 'swap';
          if (i === 2) return '--chain';
          if (i === 3) return 'sol';
        }
        return Reflect.get(target, prop, recv);
      }
    });
    await runGmgnCli(evil as unknown as string[]);
    // Whatever happened, execFile must NEVER have received 'swap'.
    if (execMock.mock.calls.length > 0) {
      const [, args] = execMock.mock.calls[0]!;
      expect((args as string[]).includes('swap')).toBe(false);
      // And every executed arg is a primitive string.
      for (const a of args as unknown[]) expect(typeof a).toBe('string');
    }
  });
});
