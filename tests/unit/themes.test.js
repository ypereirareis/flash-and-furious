'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const themes = require('../../server/themes');

test('themes: unique ids, default valid', () => {
  const ids = themes.list().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(themes.isValid(themes.DEFAULT_THEME));
  assert.ok(!themes.isValid('nope'));
});

test('css: one rule per theme', () => {
  const css = themes.css();
  for (const t of themes.list()) assert.ok(css.includes(`[data-theme="${t.id}"]`), t.id);
});
