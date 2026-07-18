export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const encode = (value: unknown) => {
    const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.map(encode).join(','), ...rows.map((row) => headers.map((header) => encode(row[header])).join(','))].join('\r\n');
}

export function toJsonDocument(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
}
