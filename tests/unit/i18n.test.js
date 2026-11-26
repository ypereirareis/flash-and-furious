'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../../src/server/i18n');

test('languages: English and French, English as the fallback', () => {
  assert.deepEqual(i18n.LANGS, ['en', 'fr']);
  assert.equal(i18n.FALLBACK, 'en');
  assert.deepEqual(i18n.list(), [{ id: 'en', label: 'English' }, { id: 'fr', label: 'Français' }]);
  assert.ok(i18n.isValid('fr') && !i18n.isValid('de') && !i18n.isValid(undefined));
});

test('t: translation, placeholders, fallbacks', () => {
  assert.equal(i18n.t('en', 'booth.smile'), 'Smile!');
  assert.equal(i18n.t('fr', 'booth.smile'), 'Souriez !');
  assert.equal(i18n.t('fr', 'booth.lastPhotoAt', { time: '20:15' }), 'Dernière photo · 20:15');
  assert.equal(i18n.t('en', 'booth.lastPhotoAt'), 'Last photo · {time}', 'unknown placeholder kept');
  assert.equal(i18n.t('de', 'booth.smile'), 'Smile!', 'unknown language: English');
  assert.equal(i18n.t('fr', 'no.such.key'), 'no.such.key', 'unknown key: the key itself');
});

test('has: known keys only', () => {
  assert.ok(i18n.has('fr', 'camera.claimed'));
  assert.ok(!i18n.has('fr', 'camera.nope'));
});
