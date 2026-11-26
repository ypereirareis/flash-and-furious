'use strict';

// Black & white module: chosen per shot on the tablet, applied after the green screen,
// before the layers (frame, decorations) that keep their colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'));
process.env.CONFIG_DIR = tmp;
const { def, features, edit, settings } = require('../../../../../tests/unit/modules');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
settings.load();

const grey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 3;

test('chosen on the tablet: part of the shot only when asked', async () => {
  const bw = def('bw');
  assert.equal(bw.forShot(settings.get(), {}), null);
  assert.equal(bw.forShot(settings.get(), { bw: false }), null);
  assert.equal(bw.forShot(settings.get(), { bw: true }), true);
  assert.deepEqual(await features.forShot(settings.get(), { bw: true }), { bw: true });
  assert.deepEqual(features.journalDetails({ bw: true }), [{ key: 'bw.journal.with' }]);
  assert.equal(features.step({ bw: true }).key, 'bw.applying');
});

test('the photo turns grey, the right way up', async () => {
  const src = path.join(tmp, 'src.jpg');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 220, g: 30, b: 30 } } }).withMetadata({ orientation: 6 }).jpeg().toFile(src);
  const dst = path.join(tmp, 'bw.jpg');
  await edit({ bw: true }, src, dst);
  const { data, info } = await sharp(dst).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [200, 300]);
  assert.ok(grey([...data.subarray(0, 3)]), `grey: ${[...data.subarray(0, 3)]}`);
});
