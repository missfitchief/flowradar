// FlowRadar — tiny RFC4180 CSV helper for the graph export route (Task 20
// binding decision 5). Pure functions, no I/O — kept here (not apps/web) so
// they're unit-testable under packages/db/test alongside the rest of the
// graph module, and reusable by any future export path.

/**
 * Escapes a single CSV field per RFC4180: wraps the value in double quotes
 * (and doubles any embedded double quote) if it contains a comma, a double
 * quote, or a newline (\n or \r). Values needing no escaping are returned
 * unchanged (no gratuitous quoting).
 */
export function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Joins already-stringified field values into one CSV row (escaped, comma-joined, no trailing newline). */
export function csvRow(fields: (string | number)[]): string {
  return fields.map((f) => csvEscape(String(f))).join(',');
}

/** Builds a full CSV document (header + data rows), each row/line separated by \r\n per RFC4180, no trailing newline. */
export function buildCsv(header: string[], rows: (string | number)[][]): string {
  const lines = [csvRow(header), ...rows.map((r) => csvRow(r))];
  return lines.join('\r\n');
}
