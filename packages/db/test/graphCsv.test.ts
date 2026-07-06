// FlowRadar — CSV helper unit tests (Task 20 binding decision 5). Pure
// functions, no DB — always runs regardless of LITE Postgres reachability.

import { describe, expect, it } from 'vitest';
import { buildCsv, csvEscape, csvRow } from '../src/graph/csv';

describe('csvEscape', () => {
  it('returns a plain value unchanged when it needs no escaping', () => {
    expect(csvEscape('plainValue')).toBe('plainValue');
  });

  it('wraps and doubles quotes for a value containing both a comma and a double quote', () => {
    expect(csvEscape('value, with "quotes"')).toBe('"value, with ""quotes"""');
  });

  it('wraps a value containing a newline', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('wraps a value containing a carriage return', () => {
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
  });

  it('wraps a value containing only a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });
});

describe('csvRow', () => {
  it('joins mixed string/number fields, escaping as needed', () => {
    expect(csvRow(['addr1', 3, 'tag1|tag2'])).toBe('addr1,3,tag1|tag2');
  });

  it('escapes a field with a comma+quote alongside untouched fields', () => {
    expect(csvRow(['addr1', 'label, "special"', 42])).toBe('addr1,"label, ""special""",42');
  });
});

describe('buildCsv', () => {
  it('builds a header + rows document joined by CRLF with no trailing newline', () => {
    const csv = buildCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
    expect(csv).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('escapes values within data rows', () => {
    const csv = buildCsv(['address', 'label'], [['addr1', 'has, comma and "quote"']]);
    expect(csv).toBe('address,label\r\naddr1,"has, comma and ""quote"""');
  });
});
