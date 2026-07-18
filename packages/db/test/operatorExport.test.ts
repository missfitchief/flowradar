import { describe, expect, it } from 'vitest';
import { toCsv, toJsonDocument } from '../src/operator/export';

describe('operator exports', () => {
  it('escapes CSV cells and serializes bigint JSON safely', () => {
    expect(toCsv([{ address: '0xabc', note: 'a,"b"', nested: { ok: true } }])).toBe('address,note,nested\r\n0xabc,"a,""b""","{""ok"":true}"');
    expect(toJsonDocument({ cursor: 12n })).toContain('"12"');
  });
});
