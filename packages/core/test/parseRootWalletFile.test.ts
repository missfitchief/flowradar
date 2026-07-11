// FlowRadar — parseRootWalletFile (Capital Lineage Engine, Phase 6a).
// Operator requirement: the parser is GENERIC — N valid roots is determined
// by the input, never hardcoded. Every count assertion below is computed
// from the fixture the test itself builds, not from a literal tied to any
// real operator file.

import { describe, expect, it } from 'vitest';
import { parseRootWalletFile } from '../src/lineage/parseRootWalletFile';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Test-local base58 ENCODER: 32 deterministic bytes -> valid Solana-shaped address. */
function syntheticAddress(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7 + 1) % 256;
  if (bytes[0] === 0) bytes[0] = 1; // avoid leading-zero '1' padding ambiguity
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  while (acc > 0n) {
    out = BASE58_ALPHABET[Number(acc % 58n)] + out;
    acc /= 58n;
  }
  return out;
}

describe('parseRootWalletFile', () => {
  it('parses an arbitrary-size fixture — every valid unique root, count derived from input (120 here, no production limit)', () => {
    const n = 120;
    const addresses = Array.from({ length: n }, (_, i) => syntheticAddress(i + 1));
    const result = parseRootWalletFile(addresses.join('\n'));
    expect(result.roots).toHaveLength(n);
    expect(result.roots.map((r) => r.address)).toEqual(addresses);
    expect(result.duplicates).toHaveLength(0);
    expect(result.evmParked).toHaveLength(0);
    expect(result.malformed).toHaveLength(0);
  });

  it('works with exactly 1 root', () => {
    const result = parseRootWalletFile(syntheticAddress(7));
    expect(result.roots).toHaveLength(1);
  });

  it('works with an empty file', () => {
    const result = parseRootWalletFile('');
    expect(result.roots).toHaveLength(0);
    expect(result.malformed).toHaveLength(0);
  });

  it('deduplicates repeated addresses, reporting each repeat with its first-occurrence line', () => {
    const a = syntheticAddress(1);
    const b = syntheticAddress(2);
    const result = parseRootWalletFile([a, b, a, a].join('\n'));
    expect(result.roots).toHaveLength(2);
    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates[0]).toMatchObject({ address: a, line: 3, firstLine: 1 });
  });

  it('parks EVM 0x addresses separately (never silently dropped, never treated as Solana)', () => {
    const sol = syntheticAddress(3);
    const result = parseRootWalletFile([sol, '0xcd83f4c3a4b96d56367e482a3774802877b82e13'].join('\n'));
    expect(result.roots).toHaveLength(1);
    expect(result.evmParked).toHaveLength(1);
    expect(result.evmParked[0]!.address).toBe('0xcd83f4c3a4b96d56367e482a3774802877b82e13');
  });

  it('reports malformed rows (bad base58, wrong byte length) with reasons', () => {
    const result = parseRootWalletFile(['not-an-address!!', 'abc', `${syntheticAddress(4)}ZZZZZZZZZZZ`].join('\n'));
    expect(result.roots).toHaveLength(0);
    expect(result.malformed).toHaveLength(3);
    for (const row of result.malformed) expect(row.reason).toBeTruthy();
  });

  it('ignores blank lines and full-line comments; preserves inline labels after | or #', () => {
    const a = syntheticAddress(5);
    const b = syntheticAddress(6);
    const content = [
      '',
      '# full-line comment',
      `${a} | insider wallet one`,
      '   ',
      `${b} # from telegram group`,
      '| stray comment line'
    ].join('\n');
    const result = parseRootWalletFile(content);
    expect(result.roots).toHaveLength(2);
    expect(result.roots[0]).toMatchObject({ address: a, label: 'insider wallet one' });
    expect(result.roots[1]).toMatchObject({ address: b, label: 'from telegram group' });
    expect(result.blankLines).toBe(2);
    expect(result.commentLines).toBe(2);
  });

  it('handles CRLF line endings and surrounding whitespace', () => {
    const a = syntheticAddress(8);
    const result = parseRootWalletFile(`  ${a}  \r\n`);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.address).toBe(a);
    expect(result.totalLines).toBe(1); // trailing newline is not a phantom line
  });

  it('parks uppercase-prefixed EVM rows (0X…) and gives 0x-shaped-but-wrong-length rows an EVM-specific reason', () => {
    const result = parseRootWalletFile(
      ['0XCD83F4C3A4B96D56367E482A3774802877B82E13', '0xcd83f4c3a4b96d56367e482a3774802877b82e1'].join('\n')
    );
    expect(result.evmParked).toHaveLength(1); // uppercase prefix still parks
    expect(result.malformed).toHaveLength(1); // 39 hex chars: malformed, but honestly labeled
    expect(result.malformed[0]!.reason).toMatch(/EVM/);
  });
});
