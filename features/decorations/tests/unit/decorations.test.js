'use strict';

// Theme decorations module: the theme's drawings on the photos, with or without a frame,
// in colour over black & white.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deco-'));
process.env.CONFIG_DIR = tmp;
const { def, edit, settings, core } = require('../../../../tests/unit/modules');
const { files, DECO_DIR } = require('../..');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
settings.load();

const pixel = async (file, x, y) => [...(await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
const grey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 3;

test('files: found by theme id, optional for a theme, every file matches a theme', () => {
  const birthday = files('birthday');
  assert.equal(birthday.id, 'birthday');
  for (const part of ['corner', 'top', 'pattern']) assert.ok(fs.existsSync(birthday[part]), part);
  assert.equal(files('night'), null, 'theme without decorations');
  assert.equal(files('../etc'), null);
  // a file named after a theme that does not exist (renamed theme?) would never be shown
  const ids = core.themes.list().map((t) => t.id);
  for (const f of fs.readdirSync(DECO_DIR)) {
    const m = f.match(/^([\w-]+)-(corner|top|pattern)\.svg$/);
    assert.ok(m, `unexpected file name: ${f}`);
    assert.ok(ids.includes(m[1]), `no theme "${m[1]}" for ${f}`);
  }
});

test('photos: only when chosen, and for themes with decorations', () => {
  const deco = def('decorations');
  assert.equal(deco.forShot({ photoDeco: false, theme: 'birthday' }), null);
  assert.equal(deco.forShot({ photoDeco: true, theme: 'night' }), null, 'theme without decorations');
  assert.equal(deco.forShot({ photoDeco: true, theme: 'birthday' }).id, 'birthday');
});

test('settings: on the tablet by default, not on photos; checked, in the journal', async () => {
  const deco = def('decorations');
  assert.deepEqual([settings.get().screenDeco, settings.get().photoDeco], [true, false]);
  assert.equal((await settings.update({ photoDeco: 'yes', screenDeco: 0 })).photoDeco, true);
  assert.equal(settings.get().screenDeco, false);
  assert.deepEqual(deco.settingsPatch({ photoDeco: 0, screenDeco: 1, mirror: true }), { patch: { photoDeco: false, screenDeco: true } });
  assert.deepEqual(deco.settingsPatch({}), { patch: {} });
  const added = [];
  deco.journalSettings({ photoDeco: false, screenDeco: true }, { photoDeco: true, screenDeco: false }, (k) => added.push(k));
  assert.deepEqual(added, ['decorations.journal.screenOff', 'decorations.journal.photosOn']);
  const dto = deco.settingsDto(settings.get());
  assert.deepEqual(dto.decoThemes.sort(), ['birthday', 'christmas', 'halloween', 'wedding']);
});

test('on a photo without frame, in colour over black & white, middle untouched', async () => {
  const src = path.join(tmp, 'src.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 30, b: 220 } } }).jpeg().toFile(src);
  const birthday = def('decorations').forShot({ photoDeco: true, theme: 'birthday' });
  const plain = path.join(tmp, 'plain.jpg');
  const decorated = path.join(tmp, 'decorated.jpg');
  await edit({ bw: true }, src, plain);
  await edit({ bw: true, decorations: birthday }, src, decorated);
  const corner = [];
  for (let x = 20; x < 300; x += 20) corner.push(await pixel(decorated, x, 720));
  assert.ok(corner.some((c) => !grey(c)), 'drawing in colour in the bottom-left corner');
  assert.deepEqual(await pixel(decorated, 900, 400), await pixel(plain, 900, 400), 'middle untouched');
});
