'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const themes = require('../../server/themes');

test('themes: unique ids, default valid', () => {
  const ids = themes.list().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(themes.isValid(themes.DEFAULT_THEME));
  assert.ok(!themes.isValid('nope'));
});

test('decoFiles: existing SVG files for themes with decorations, null otherwise', () => {
  const withDeco = themes.list().filter((t) => t.hasDeco);
  assert.ok(withDeco.length > 0);
  for (const t of withDeco) {
    const d = themes.decoFiles(t.id);
    assert.equal(d.id, t.id);
    for (const f of [d.corner, d.top].filter(Boolean)) assert.ok(fs.existsSync(f), f);
  }
  assert.equal(themes.decoFiles('night'), null);
  assert.equal(themes.decoFiles('nope'), null);
});

test('css: one rule per theme', () => {
  const css = themes.css();
  for (const t of themes.list()) assert.ok(css.includes(`[data-theme="${t.id}"]`), t.id);
});
