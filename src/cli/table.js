export function printTable(rows, columns, out = process.stdout) {
  if (!rows.length) {
    out.write('(no rows)\n');
    return;
  }
  const widths = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (vals) => vals.map((v, i) => (columns[i].align === 'right' ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]))).join('  ');
  out.write(`${line(columns.map((c) => c.title))}\n`);
  out.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const r of rows) out.write(`${line(columns.map((c) => r[c.key] ?? ''))}\n`);
}
