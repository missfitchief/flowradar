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
  constructor(argv: readonly string[]) {
    super(`GMGN command not on the read-only allowlist: "${argv.slice(0, 2).join(' ') || '<empty>'}" — refusing to invoke`);
    this.name = 'GmgnForbiddenCommandError';
  }
}

/** Throws unless argv[0..1] is an allowed read-only `<family> <subcommand>`. */
export function assertGmgnCommandAllowed(argv: readonly string[]): void {
  const pair = `${argv[0] ?? ''} ${argv[1] ?? ''}`.trim();
  if (!ALLOWED_PAIRS.has(pair)) throw new GmgnForbiddenCommandError(argv);
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
  try {
    return require.resolve('gmgn-cli/dist/index.js');
  } catch {
    throw new Error('gmgn-cli not found — install it or pass cliPath');
  }
}

/** Runs an ALLOWED read-only gmgn-cli command and returns parsed JSON (the
 *  callers always pass --raw). Rejects forbidden commands BEFORE spawning. */
export async function runGmgnCli(argv: readonly string[], opts: GmgnCliOptions = {}): Promise<unknown> {
  assertGmgnCommandAllowed(argv); // gate BEFORE any process work
  const cli = resolveCliPath(opts.cliPath);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...argv],
      { timeout: opts.timeoutMs ?? 30_000, shell: false, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch {
          reject(new Error(`gmgn-cli returned non-JSON output for "${argv.slice(0, 2).join(' ')}"`));
        }
      }
    );
  });
}
