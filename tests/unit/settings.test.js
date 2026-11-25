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
process.env.FRAME_TITLE = 'Our party';
const settings = require('../../server/settings');
const file = path.join(dir, 'settings.json');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('defaults when nothing is saved', () => {
  assert.deepEqual(settings.load(), {
    mirror: true, live: false, frame: null, frameTitle: 'Our party', theme: 'night', frameDeco: false, lang: 'fr',
    greenScreen: false, background: null, greenTolerance: 50, greenKey: null,
  });
});

test('green screen settings cleaned up', async () => {
  let s = await settings.update({ greenScreen: 1, background: '../x', greenTolerance: 140, greenKey: { lo: 30, hi: 20 } });
  assert.deepEqual([s.greenScreen, s.background, s.greenTolerance, s.greenKey], [true, null, 100, null]);
  s = await settings.update({ background: '02-space', greenTolerance: '35', greenKey: { lo: 20, hi: 50, coverage: 60, at: 5, extra: 1 } });
  assert.deepEqual([s.background, s.greenTolerance, s.greenKey], ['02-space', 35, { lo: 20, hi: 50, coverage: 60, at: 5 }]);
  s = await settings.update({ greenTolerance: 'abc', greenScreen: false, background: null, greenKey: null });
  assert.equal(s.greenTolerance, 50);
});

test('update: values cleaned up, saved, read again on load', async () => {
  const s = await settings.update({
    frameTitle: `  Happy   birthday\n ${'x'.repeat(100)}`,
    frame: '02-fete', // legacy id
    theme: 'anniversaire', // legacy id
    lang: 'de', // unknown: default
    live: 1,
  });
  assert.equal(s.frameTitle.length, settings.MAX_TITLE);
  assert.match(s.frameTitle, /^Happy birthday x+$/);
  assert.equal(s.frame, '02-party');
  assert.equal(s.theme, 'birthday');
  assert.equal(s.lang, 'fr');
  assert.equal(s.live, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s);
  assert.deepEqual(settings.load(), s);
});

test('update: unsafe frame ids and unknown themes are refused', async () => {
  assert.equal((await settings.update({ frame: '../../etc/passwd' })).frame, null);
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
  assert.equal(settings.load().frameTitle, 'Our party');
});
