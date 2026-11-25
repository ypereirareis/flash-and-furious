'use strict';

// Timings table of the functional tests (run by scripts/test.sh at the end).
const fs = require('fs');
const path = require('path');

const file = path.join(process.argv[2] || process.env.TEST_WORK_DIR || '.', 'timings.jsonl');
if (!fs.existsSync(file)) process.exit(0);
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.label)) groups.set(r.label, []);
  groups.get(r.label).push(r);
}
const range = (vals) => {
  const v = vals.filter((x) => x !== null);
  if (!v.length) return '-';
  const [lo, hi] = [Math.min(...v), Math.max(...v)];
  return lo === hi ? `${lo.toFixed(2)} s` : `${lo.toFixed(2)} to ${hi.toFixed(2)} s`;
};
const lines = [['Shot', 'Count', 'Capture to tablet', 'Of which processing']];
for (const [label, list] of groups) {
  lines.push([label, String(list.length), range(list.map((r) => r.captureToTablet)), range(list.map((r) => r.processingWait))]);
}
const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
console.log(`\nTimings (${rows[0].camera} camera):`);
lines.forEach((l, i) => {
  console.log(`  ${l.map((c, j) => c.padEnd(widths[j])).join('  ')}`);
  if (i === 0) console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
});
