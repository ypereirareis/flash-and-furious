'use strict';

// Processing of a photo (server/photo.js): the stages the feature modules plug into.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const photo = require('../../server/photo');

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

test('no edit: the right way up, limited to maxSize', async () => {
  const dst = path.join(tmp, 'plain.jpg');
  await photo.process(await testPhoto('plain.jpg', { orientation: 6 }), dst, { maxSize: 600 });
  const m = await sharp(dst).metadata();
  assert.deepEqual([m.width, m.height], [400, 600], 'portrait, at most 600 px');
  const [r, , b] = await pixel(dst, 200, 100);
  assert.ok(r > 150 && b < 100, 'colours kept');
});

test('stages in order: pixels, then image, then layers in colour over it', async () => {
  const dst = path.join(tmp, 'stages.jpg');
  const order = [];
  const square = (colour, name) => async (w) => {
    order.push(name);
    return [{ input: await sharp({ create: { width: 50, height: 50, channels: 3, background: colour } }).png().toBuffer(), left: Math.round(w / 2), top: 10 }];
  };
  const white = async ({ data }) => { order.push('pixels 1'); return Buffer.from(data).fill(255); };
  const darker = async ({ data }) => { order.push('pixels 2'); return data.map((v) => v - 55); };
  const toGrey = (img) => { order.push('image'); return img.greyscale(); };
  await photo.process(await testPhoto('stages.jpg'), dst, {
    pixels: [white, darker], image: [toGrey], layers: [square('#00ff00', 'layer 1'), square('#ff0000', 'layer 2')],
  });
  assert.deepEqual(order, ['pixels 1', 'pixels 2', 'image', 'layer 1', 'layer 2']);
  const [r, g, b] = await pixel(dst, 625, 35);
  assert.ok(r > 200 && g < 60 && b < 60, `last layer on top, in colour: ${[r, g, b]}`);
  const p = await pixel(dst, 100, 400);
  assert.ok(grey(p) && p[0] > 190 && p[0] < 210, `pixels steps chained: ${p}`);
});
