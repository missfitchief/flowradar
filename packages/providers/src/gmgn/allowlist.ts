// FlowRadar — GMGN runtime command allowlist (Task 1 guard).
//
// THE ONLY path FlowRadar may invoke gmgn-cli through. It enforces a positive
// allowlist of READ-ONLY intel command pairs before any process is spawned,
// so an execution / key-management family (swap, multi-swap, order, cooking,
// config --apply, gas-price, portfolio info/token-balance/created-tokens,
// transaction signing) can never be launched — complementing the static
// source grep guard in gmgnQueryOnlyGuard.test.ts.
//
// gmgn-cli is invoked as `node <resolved dist/index.js> <argv...>` with
// shell:false: Node 24 refuses to spawn a .cmd without a shell, and a shell
// would reintroduce injection and defeat the argv allowlist.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Allowed `<family> <subcommand>` pairs — EXACTLY the read-only intel set the
 *  capability report documented for this branch (sol-only usage). Anything not
 *  here is rejected. `market signal` is included (documented read-only). */
const ALLOWED_PAIRS = new Set<string>([
  'track smartmoney',
  'track kol',
  'track follow-wallet',
  'market trenches',
  'market trending',
  'market signal',
  'token info',
  'token security',
  'token pool',
  'token holders',
  'token traders',
  'portfolio holdings',
  'portfolio stats',
  'portfolio activity'
]);

export class GmgnForbiddenCommandError extends Error {
  constructor(argv: unknown) {
    // Robust to ANY argv shape (non-array, non-string elements) — the
    // constructor must never itself throw and mask the rejection.
    const label = Array.isArray(argv)
      ? argv.slice(0, 2).map((a) => (typeof a === 'string' ? a : typeof a)).join(' ') || '<empty>'
      : typeof argv;
    super(`GMGN command not on the read-only allowlist: "${label}" — refusing to invoke`);
    this.name = 'GmgnForbiddenCommandError';
  }
}

/**
 * Throws unless argv is an array whose FIRST TWO elements are EXACT plain
 * strings forming an allowed `<family> <subcommand>` pair. Fail-closed on
 * everything else (Codex P1): non-array, empty, non-string / object / accessor
 * elements (a stringify-once-execute-different TOCTOU), or whitespace-padded
 * tokens. Returns the validated pair so callers can reason about what passed.
 */
export function assertGmgnCommandAllowed(argv: readonly unknown[]): { family: string; subcommand: string } {
  if (!Array.isArray(argv) || argv.length < 2) throw new GmgnForbiddenCommandError(argv);
  const family = argv[0];
  const subcommand = argv[1];
  // EXACT primitive strings only — a String object, number, or getter is
  // rejected (it could coerce differently at spawn time). No trimming: a
  // padded token is malformed, not allowed.
  if (typeof family !== 'string' || typeof subcommand !== 'string') throw new GmgnForbiddenCommandError(argv);
  if (family !== family.trim() || subcommand !== subcommand.trim()) throw new GmgnForbiddenCommandError(argv);
  if (!ALLOWED_PAIRS.has(`${family} ${subcommand}`)) throw new GmgnForbiddenCommandError(argv);
  // Every REMAINING element must also be a plain string (they become literal
  // execFile args; a non-string could stringify unexpectedly).
  for (let i = 2; i < argv.length; i++) {
    if (typeof argv[i] !== 'string') throw new GmgnForbiddenCommandError(argv);
  }
  return { family, subcommand };
}

export interface GmgnCliOptions {
  timeoutMs?: number;
  /** Resolved gmgn-cli JS entry; defaults to the globally-installed package. */
  cliPath?: string;
}

function resolveCliPath(explicit?: string): string {
  if (explicit) return explicit;
  const appdata = process.env.APPDATA;
  if (appdata) {
    const p = path.join(appdata, 'npm', 'node_modules', 'gmgn-cli', 'dist', 'index.js');
    if (existsSync(p)) return p;
  }
  // Fallback: node's own resolution (works when gmgn-cli is a local dep).
  // createRequire gives a working require in the emitted ESM (bare `require`
  // is undefined there — Codex P2).
  try {
    return createRequire(import.meta.url).resolve('gmgn-cli/dist/index.js');
  } catch {
    throw new Error('gmgn-cli not found — install it or pass cliPath');
  }
}

/** Runs an ALLOWED read-only gmgn-cli command and returns parsed JSON (the
 *  callers always pass --raw). Rejects forbidden commands BEFORE spawning. */
export async function runGmgnCli(argv: readonly unknown[], opts: GmgnCliOptions = {}): Promise<unknown> {
  // SNAPSHOT FIRST, then validate + execute the SAME snapshot (Codex P1): a
  // Proxy/getter array could return an allowed value when validated and a
  // different one when read again for exec. We copy each element exactly once
  // (structuredClone of a length-fixed shallow array), reject non-string
  // elements, validate the snapshot, and execute that immutable snapshot.
  if (!Array.isArray(argv)) throw new GmgnForbiddenCommandError(argv);
  // Copy into a GUARANTEED-plain array element-by-element (Codex P1 round 3):
  // Array.prototype.slice honors the input's constructor[Symbol.species], so a
  // hostile species could hand back a Proxy "snapshot" that still swaps values
  // between the validate read and the exec read. A hand-built literal array +
  // a fixed numeric length (coerced once, capped) consults no input species and
  // reads each index exactly once.
  const len = Math.min(Number((argv as { length: unknown }).length) | 0, 256);
  const snapshot: unknown[] = [];
  for (let i = 0; i < len; i++) snapshot.push((argv as readonly unknown[])[i]);
  assertGmgnCommandAllowed(snapshot); // rejects any non-string element too
  const safeArgv = snapshot as string[]; // proven all-string by the assert
  const cli = resolveCliPath(opts.cliPath);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...safeArgv],
      { timeout: opts.timeoutMs ?? 30_000, shell: false, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch {
          reject(new Error(`gmgn-cli returned non-JSON output for "${safeArgv.slice(0, 2).join(' ')}"`));
        }
      }
    );
  });
}
