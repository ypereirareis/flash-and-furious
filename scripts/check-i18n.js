#!/usr/bin/env node
'use strict';

/**
 * Checks the UI translations (public/locales/*.json):
 *  - every language has exactly the same keys as English, with the same {placeholders};
 *  - every key used in the code exists;
 *  - driver-specific camera texts ("cameras.<id>.<name>") override an existing generic text.
 * No dependencies: `node scripts/check-i18n.js` (exit code 1 on error).
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const localesDir = path.join(root, 'public', 'locales');
const langs = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));
const dicts = Object.fromEntries(langs.map((l) => [l, JSON.parse(read(`public/locales/${l}.json`))]));
const errors = [];

/** Flattens { a: { b: 'x' } } into { 'a.b': 'x' } (arrays are leaves). */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
const placeholders = (v) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) || [])].sort().join(',');

// 1. Same keys and placeholders in every language
const en = flatten(dicts.en);
for (const lang of langs.filter((l) => l !== 'en')) {
  const other = flatten(dicts[lang]);
  for (const k of Object.keys(en)) {
    if (!(k in other)) errors.push(`${lang}.json: missing key "${k}"`);
    else if (placeholders(en[k]) !== placeholders(other[k])) errors.push(`${lang}.json: placeholders differ for "${k}"`);
    else if (Array.isArray(en[k]) !== Array.isArray(other[k])) errors.push(`${lang}.json: "${k}" must be ${Array.isArray(en[k]) ? 'a list' : 'a text'}`);
  }
  for (const k of Object.keys(other)) if (!(k in en)) errors.push(`${lang}.json: unknown key "${k}" (not in en.json)`);
}

// 2. Keys used in the code
const files = [
  ...['public/app.js', 'public/admin.js', 'public/index.html', 'public/admin.html', 'public/slideshow.html'],
  'server/index.js',
];
const used = new Set();
const add = (re, text, map = (m) => m[1]) => { for (const m of text.matchAll(re)) used.add(map(m)); };
for (const f of files) {
  const s = read(f);
  add(/'((?:app|status|booth|slideshow|admin|shoot|settings|storage)\.\w+)'/g, s);
  add(/data-i18n(?:-html)?="([\w.]+)"/g, s);
  for (const m of s.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(';').forEach((p) => used.add(p.split(':')[1].trim()));
}
// camera texts: names referenced by the server, the drivers and live view
const index = read('server/index.js');
add(/camera: '(\w+)'/g, index, (m) => `camera.${m[1]}`);
add(/'(\w+)'/g, (index.match(/CAMERA_TEXTS = \[([^\]]*)\]/) || ['', ''])[1], (m) => `camera.${m[1]}`);
add(/return '(\w+)';/g, read('server/cameras/gphoto2.js'), (m) => `camera.${m[1]}`);
add(/'(live[A-Z]\w+)'/g, read('server/live.js'), (m) => `camera.${m[1]}`);
for (const k of used) if (!(k in en)) errors.push(`key used in the code but missing from en.json: "${k}"`);

// 3. Driver-specific overrides must match a generic camera text
for (const k of Object.keys(en).filter((x) => x.startsWith('cameras.'))) {
  const name = k.split('.').pop();
  if (!(`camera.${name}` in en)) errors.push(`en.json: "${k}" does not override any "camera.${name}" text`);
}

if (errors.length) {
  console.error(`✗ ${errors.length} translation problem(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ translations OK: ${langs.join(', ')} — ${Object.keys(en).length} keys, ${used.size} used in the code`);
