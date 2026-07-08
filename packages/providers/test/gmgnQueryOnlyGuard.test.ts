// FlowRadar — GMGN query-only enforcement (design doc §Module D "Enforcement",
// global constraint 8/20). This is a source-text grep guard: the GMGN
// confluence adapter must reference ZERO swap/order/execution/private-key/
// wallet-management endpoints. If a future edit adds any such capability, this
// test fails loudly. Reads the actual file off disk (not the compiled module).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
