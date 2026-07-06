// FlowRadar — CSV helper unit tests (Task 20 binding decision 5). Pure
// functions, no DB — always runs regardless of LITE Postgres reachability.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCsv, csvEscape, csvRow } from '../src/graph/csv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_ROUTE_PATH = resolve(__dirname, '../../../apps/web/app/api/graph/[id]/export/route.ts');

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

describe('nodes.csv export header (spec-exact column names)', () => {
  // Regression test (post-review Finding 1): the export route's nodes.csv
  // header previously used nodeType/totalSentUsd/totalReceivedUsd/
  // netFlowUsd/interactionCount; the plan mandates the exact spec names
  // asserted below (type/totalSent/totalReceived/netFlow/interactions).
  // Reads the actual header array literal out of route.ts's source text
  // (rather than duplicating it as an independent local fixture) so this
  // test genuinely fails if the route's header ever drifts from spec again
  // — buildCsv itself has no opinion on column names, so the only way to
  // pin the real route's output is to inspect its source.
  const SPEC_HEADER_LINE =
    'address,chain,depth,type,totalSent,totalReceived,netFlow,interactions,firstSeen,lastSeen,tags,confidence';

  function extractNodesCsvHeaderArray(): string[] {
    const source = readFileSync(EXPORT_ROUTE_PATH, 'utf-8');
    const match = source.match(/const header = \[([\s\S]*?)\];\s*\n\s*const rows = search\.nodes\.map/);
    if (!match) throw new Error('could not find the nodes.csv header array literal in export/route.ts');
    const fields = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    if (fields.length === 0) throw new Error('parsed zero header fields from export/route.ts — regex drifted');
    return fields;
  }

  it('matches the exact spec-mandated header string', () => {
    const csv = buildCsv(extractNodesCsvHeaderArray(), []);
    expect(csv).toBe(SPEC_HEADER_LINE);
  });
});
