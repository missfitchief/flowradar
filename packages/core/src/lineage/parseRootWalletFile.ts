// FlowRadar — Capital Lineage Engine (Phase 6a): pure root-wallet file parser.
//
// Operator contract (2026-07-10 directive): fully DYNAMIC — the number of
// roots is whatever the input contains; no count is hardcoded anywhere in
// production code, and no maximum exists at this layer (the DB importer owns
// the explicit configurable operational safety limit).
//
// Input format (operator-supplied text, one address per line):
//   - blank lines ignored
//   - full-line comments starting with '#' or '|' ignored
//   - inline labels after '|' or '#' preserved verbatim
//   - EVM 0x addresses PARKED (reported, never treated as Solana, never
//     silently dropped — they may belong to a future EVM-side task)
//   - duplicates reported with their first-occurrence line
//   - a valid Solana root must be base58 AND decode to exactly 32 bytes
//     (real pubkey check, not just an alphabet/length regex)
//
// PURE: string in, plain report out. No I/O, no DB — packages/db's
// importRootWallets consumes this.

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, bigint>([...BASE58_ALPHABET].map((c, i) => [c, BigInt(i)]));

/** Byte length of a base58 string's decoded value, or null on invalid chars. */
function base58ByteLength(s: string): number | null {
  let acc = 0n;
  for (const ch of s) {
    const v = BASE58_MAP.get(ch);
    if (v === undefined) return null;
    acc = acc * 58n + v;
  }
  let bytes = 0;
  for (const ch of s) {
    if (ch === '1') bytes += 1;
    else break;
  }
  let n = acc;
  while (n > 0n) {
    bytes += 1;
    n >>= 8n;
  }
  return bytes;
}

export interface ParsedRootWallet {
  address: string;
  label?: string;
  line: number;
}

export interface ParsedRootWalletFile {
  /** Every physical line in the input (trailing newline artifact excluded). */
  totalLines: number;
  /** Valid, unique Solana roots in input order. Size is input-determined. */
  roots: ParsedRootWallet[];
  duplicates: { address: string; line: number; firstLine: number }[];
  /** EVM (0x…) rows — parked for a future EVM-side task, never Solana. */
  evmParked: { address: string; line: number; label?: string }[];
  malformed: { raw: string; line: number; reason: string }[];
  blankLines: number;
  commentLines: number;
}

export function parseRootWalletFile(content: string): ParsedRootWalletFile {
  const lines = content.split(/\r?\n/);
  // A trailing newline produces one phantom empty final element — not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const roots: ParsedRootWallet[] = [];
  const duplicates: ParsedRootWalletFile['duplicates'] = [];
  const evmParked: ParsedRootWalletFile['evmParked'] = [];
  const malformed: ParsedRootWalletFile['malformed'] = [];
  let blankLines = 0;
  let commentLines = 0;
  const firstLineByAddress = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i]!.trim();

    if (trimmed === '') {
      blankLines += 1;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('|')) {
      commentLines += 1;
      continue;
    }

    const match = trimmed.match(/^([^|#]+)(?:[|#]\s*(.*))?$/);
    const address = (match?.[1] ?? '').trim();
    const label = match?.[2]?.trim() || undefined;

    if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
      evmParked.push({ address, line: lineNo, ...(label !== undefined ? { label } : {}) });
      continue;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      malformed.push({ raw: trimmed, line: lineNo, reason: 'not base58 or wrong length for a Solana pubkey' });
      continue;
    }
    const byteLength = base58ByteLength(address);
    if (byteLength !== 32) {
      malformed.push({ raw: trimmed, line: lineNo, reason: `base58 decodes to ${byteLength} bytes, expected 32` });
      continue;
    }

    const firstLine = firstLineByAddress.get(address);
    if (firstLine !== undefined) {
      duplicates.push({ address, line: lineNo, firstLine });
      continue;
    }
    firstLineByAddress.set(address, lineNo);
    roots.push({ address, line: lineNo, ...(label !== undefined ? { label } : {}) });
  }

  return { totalLines: lines.length, roots, duplicates, evmParked, malformed, blankLines, commentLines };
}
