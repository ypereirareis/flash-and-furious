'use strict';

// Processing of a photo (server/photo.js) and the theme decorations (server/decorations.js),
// without any optional feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const photo = require('../../server/photo');
const decorations = require('../../server/decorations');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 1200 × 800 test photo, left half red, right half blue, with an optional EXIF orientation. */
async function testPhoto(name, { orientation } = {}) {
  const file = path.join(tmp, name);
  const half = (r, g, b) => ({ create: { width: 600, height: 800, channels: 3, background: { r, g, b } } });
  let img = sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).composite([
    { input: await sharp(half(220, 30, 30)).png().toBuffer(), left: 0, top: 0 },
    { input: await sharp(half(30, 30, 220)).png().toBuffer(), left: 600, top: 0 },
  ]);
  if (orientation) img = img.withMetadata({ orientation });
  await img.jpeg({ quality: 95 }).toFile(file);
  return file;
}
const pixel = async (file, x, y) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const grey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 3;

test('black & white, the right way up, limited to maxSize', async () => {
  const dst = path.join(tmp, 'bw.jpg');
  await photo.process(await testPhoto('bw.jpg', { orientation: 6 }), dst, { bw: true, maxSize: 600 });
  const m = await sharp(dst).metadata();
  assert.deepEqual([m.width, m.height], [400, 600], 'portrait, at most 600 px');
  assert.ok(grey(await pixel(dst, 200, 300)));
});

test('retouch before black & white, overlays in colour over it, in order', async () => {
  const dst = path.join(tmp, 'layers.jpg');
  const order = [];
  const square = (colour, name) => async (w) => {
    order.push(name);
    return [{ input: await sharp({ create: { width: 50, height: 50, channels: 3, background: colour } }).png().toBuffer(), left: Math.round(w / 2), top: 10 }];
  };
  const retouch = async ({ data }) => Buffer.from(data).fill(255); // all white
  await photo.process(await testPhoto('layers.jpg'), dst, { retouch, bw: true, overlays: [square('#00ff00', 'first'), square('#ff0000', 'second')] });
  assert.deepEqual(order, ['first', 'second']);
  const [r, g, b] = await pixel(dst, 625, 35);
  assert.ok(r > 200 && g < 60 && b < 60, `last overlay on top, in colour: ${[r, g, b]}`);
  assert.ok(await pixel(dst, 100, 400).then((p) => p.every((v) => v > 240)), 'retouched photo');
});

test('theme decorations: on a photo without frame, only when chosen', async () => {
  assert.equal(decorations.forPhoto({ photoDeco: false, theme: 'birthday' }), null);
  assert.equal(decorations.forPhoto({ photoDeco: true, theme: 'night' }), null, 'theme without decorations');
  const deco = decorations.forPhoto({ photoDeco: true, theme: 'birthday' });
  assert.equal(deco.id, 'birthday');
  const plain = path.join(tmp, 'plain.jpg');
  const decorated = path.join(tmp, 'decorated.jpg');
  const src = await testPhoto('deco.jpg');
  await photo.process(src, plain, { bw: true });
  await photo.process(src, decorated, { bw: true, overlays: [decorations.overlay(deco)] });
  assert.ok(!grey(await pixel(decorated, 150, 700)) || !grey(await pixel(decorated, 100, 650)), 'drawing in colour in the bottom-left corner');
  assert.deepEqual(await pixel(decorated, 900, 400), await pixel(plain, 900, 400), 'middle untouched');
  assert.equal(decorations.overlay(null), null);
});
