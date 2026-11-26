'use strict';

// Each test file runs in its own process: the settings module gets a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
process.env.CONFIG_DIR = dir;
process.env.DEFAULT_LANG = 'fr';
const settings = require('../../server/settings');
const file = path.join(dir, 'settings.json');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('defaults when nothing is saved', () => {
  assert.deepEqual(settings.load(), {
    mirror: true, live: false, theme: 'night', lang: 'fr',
  });
});

test('settings added by a feature module: defaults, clean-up, saved in the same file', async () => {
  settings.extend({ defaults: { extra: 1 }, sanitize: (v) => ({ extra: Number(v.extra) > 0 ? Number(v.extra) : 1 }) });
  assert.equal(settings.get().extra, 1);
  assert.equal((await settings.update({ extra: '7' })).extra, 7);
  assert.equal((await settings.update({ extra: -3 })).extra, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).extra, 1);
  assert.equal(settings.load().extra, 1);
});

test('update: values cleaned up, saved, read again on load', async () => {
  const s = await settings.update({
    theme: 'birthday',
    lang: 'de', // unknown: default
    live: 1,
    mirror: 0,
    unknown: 1, // not a setting: dropped
  });
  assert.equal(s.theme, 'birthday');
  assert.equal(s.mirror, false);
  assert.ok(!('unknown' in s));
  assert.equal(s.lang, 'fr');
  assert.equal(s.live, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s);
  assert.deepEqual(settings.load(), s);
});

test('update: unknown themes are refused', async () => {
  assert.equal((await settings.update({ theme: 'nope' })).theme, 'night');
});

test('update calls the chown callback with the settings file', async () => {
  const seen = [];
  await settings.update({ mirror: false }, (p) => seen.push(p));
  assert.deepEqual(seen, [file]);
});

test('get returns a copy', () => {
  settings.get().mirror = 'changed';
  assert.equal(settings.get().mirror, false);
});

test('corrupted file: defaults', () => {
  fs.writeFileSync(file, '{ not json');
  assert.equal(settings.load().theme, 'night');
});
