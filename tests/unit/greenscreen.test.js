'use strict';

// Green screen: thresholds, calibration, keying, backgrounds, and the photo pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const key = require('../../server/greenscreen-key');
const greenscreen = require('../../server/greenscreen');
const frames = require('../../server/frames');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'green-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CLOTH = [40, 175, 70];
const SKIN = [225, 175, 145];
const BG = [200, 30, 200]; // magenta: easy to recognise
/** RGB image filled by fn(x, y) -> [r, g, b] */
function image(width, height, fn) {
  const px = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set(fn(x, y), (y * width + x) * 3);
  return px;
}
const at = (px, width, x, y) => [...px.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
const close = (a, b, d = 6) => a.every((v, i) => Math.abs(v - b[i]) <= d);

test('keying: cloth replaced, person kept, edges soft', () => {
  const w = 60;
  const h = 20;
  // left half cloth, right half skin
  const photo = image(w, h, (x) => (x < 30 ? CLOTH : SKIN));
  const bg = image(w, h, () => BG);
  key.keyComposite(photo, bg, w, h, key.params(null, 50, w));
  assert.deepEqual(at(photo, w, 5, 10), BG, 'cloth -> background');
  assert.deepEqual(at(photo, w, 50, 10), SKIN, 'skin untouched');
  const edge = at(photo, w, 30, 10);
  assert.ok(!close(edge, BG) && !close(edge, SKIN), `edge blended: ${edge}`);
});

test('keying: green reflection removed from people, other colours kept', () => {
  const w = 4;
  const photo = new Uint8Array([200, 150, 120, 120, 135, 110, 250, 230, 40, 20, 20, 20]); // skin, greenish skin, yellow, black
  key.keyComposite(photo, new Uint8Array(12), w, 1, { lo: 24, hi: 60, radius: 0 });
  assert.deepEqual([...photo.subarray(0, 3)], [200, 150, 120]);
  assert.deepEqual([...photo.subarray(3, 6)], [120, 120, 110], 'green no higher than red');
  assert.deepEqual([...photo.subarray(6, 9)], [250, 230, 40], 'yellow kept');
  assert.deepEqual([...photo.subarray(9, 12)], [20, 20, 20], 'black hair kept');
});

test('tolerance: higher removes more green', () => {
  const a = key.params({ lo: 20, hi: 50 }, 0);
  const b = key.params({ lo: 20, hi: 50 }, 50);
  const c = key.params({ lo: 20, hi: 50 }, 100);
  assert.deepEqual([b.lo, b.hi], [20, 50]);
  assert.ok(a.hi > b.hi && b.hi > c.hi);
  assert.equal(key.params(null, 50).hi, key.DEFAULT_KEY.hi, 'not calibrated: defaults');
  assert.equal(key.params(null, 50, 3888).radius, 2);
});

test('calibration: unevenly lit cloth with someone in front', () => {
  const w = 200;
  const h = 100;
  // cloth darker at the bottom (shadow), a person in the middle
  const px = image(w, h, (x, y) => (x > 80 && x < 120 ? SKIN : [30, Math.round(190 - y * 0.8), 60]));
  const k = key.calibrate(px, w, h);
  assert.ok(k.coverage >= 75 && k.coverage <= 85, `coverage ${k.coverage}`);
  // the dim bottom of the cloth is still fully replaced
  const dim = 190 - 99 * 0.8 - 60;
  assert.ok(key.params(k, 50).hi <= dim + 15, `hi ${k.hi} vs dim cloth ${dim}`);
  assert.ok(k.lo > 0 && k.lo < k.hi);
});

test('calibration: no green cloth -> notGreen with its coverage', () => {
  const px = image(100, 100, (x) => (x < 10 ? CLOTH : SKIN));
  assert.throws(() => key.calibrate(px, 100, 100), (e) => e.code === 'notGreen' && Math.abs(e.coverage - 0.1) < 0.01);
});

test('box blur keeps flat areas and spreads an edge over the radius', () => {
  const src = new Uint8Array(10).fill(0, 0, 5).fill(255, 5);
  const out = key.boxBlur(src, 10, 1, 1);
  assert.deepEqual([out[0], out[9]], [0, 255]);
  assert.deepEqual([out[4], out[5]], [85, 170]);
});

test('bundled backgrounds: listed with their names, thumbnails', async () => {
  const list = await greenscreen.list();
  assert.deepEqual(list.map((b) => b.id), ['01-beach', '02-space', '03-party-lights', '04-city-night']);
  assert.equal(list[0].label, 'Beach');
  const meta = await sharp(await greenscreen.thumbnail(list[0])).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [600, 400, 'jpeg']);
});

async function greenPhoto(file, width, height) {
  // green cloth, a skin-coloured "person" in the middle
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="rgb(${CLOTH})"/>
    <rect x="40%" y="20%" width="20%" height="80%" fill="rgb(${SKIN})"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(file);
  return file;
}

test('calibrate(): thresholds and a small sample for the previews', async () => {
  const photo = await greenPhoto(path.join(tmp, 'calib.jpg'), 3000, 2000);
  const sample = path.join(tmp, 'sample.jpg');
  const k = await greenscreen.calibrate(photo, sample);
  assert.ok(k.coverage > 80 && k.coverage < 90, `coverage ${k.coverage}`);
  const meta = await sharp(sample).metadata();
  assert.equal(Math.max(meta.width, meta.height), 1200);
});

test('photo pipeline: background in place of the cloth, then black & white over everything', async () => {
  const photo = await greenPhoto(path.join(tmp, 'shot.jpg'), 1500, 1000);
  const bgDir = path.join(tmp, 'bg');
  fs.mkdirSync(bgDir);
  const bgFile = path.join(bgDir, 'magenta.png');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } }).png().toFile(bgFile);
  const green = { background: { id: 'magenta', file: bgFile, mtime: 1 }, key: null, tolerance: 50 };
  const pixel = async (file, x, y) => [...(await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];

  const colour = path.join(tmp, 'colour.jpg');
  await frames.apply(null, photo, colour, { green });
  assert.ok(close(await pixel(colour, 100, 100), BG, 12), 'cloth -> background');
  assert.ok(close(await pixel(colour, 750, 600), SKIN, 12), 'person kept');

  const bw = path.join(tmp, 'bw.jpg');
  await frames.apply(null, photo, bw, { green, bw: true, maxSize: 600 });
  const meta = await sharp(bw).metadata();
  assert.equal(meta.width, 600);
  const [r, g, b] = await pixel(bw, 40, 40);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 4, `background in grey too: ${[r, g, b]}`);
});

test('box blur: same result as a plain average, radius 1 to 5', () => {
  const w = 37;
  const h = 23;
  const src = new Uint8Array(w * h).map((_, i) => (i * 97 + (i >> 3) * 31) % 256);
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  for (let r = 1; r <= 5; r++) {
    const size = 2 * r + 1;
    // horizontal then vertical average with edge pixels repeated, rounded like the blur
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[y * w + clamp(x + d, w - 1)];
      tmp[y * w + x] = Math.floor((s + (size >> 1)) / size);
    }
    const expected = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[clamp(y + d, h - 1) * w + x];
      expected[y * w + x] = Math.floor((s + (size >> 1)) / size);
    }
    assert.deepEqual(key.boxBlur(src, w, h, r), expected, `radius ${r}`);
  }
});
