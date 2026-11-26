'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
process.env.CONFIG_DIR = tmp;
process.env.FRAME_TITLE = 'Our party';
const { def, features, edit, settings } = require('../../../../tests/unit/modules');
const { render: frames, MAX_TITLE } = require('../..');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const opts = { title: 'Coucou Marjo !!!', locale: 'fr-FR' };
const BIRTHDAY = { id: 'birthday', corner: path.join(__dirname, '../../../../public/deco/birthday-corner.svg') };

/** A photo edited with this frame (and other modules' edits: { bw, decorations }), as the server does. */
function apply(frame, src, dst, options = {}) {
  const { bw, decorations, ...rest } = options;
  const edits = { frames: frame, ...(bw ? { bw } : {}), ...(decorations ? { decorations } : {}) };
  return edit(edits, src, dst, rest);
}

/** Colourful 1200 × 800 test photo (left half red, right half blue), with an EXIF orientation. */
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

test('list: the frames of the frames/ folder, with their <title> as label', async () => {
  const list = await frames.list();
  assert.deepEqual(list.map((f) => f.id), ['01-polaroid', '02-party', '03-cinema', '04-elegant']);
  for (const f of list) assert.ok(f.label && fs.existsSync(f.file) && f.mtime > 0, f.id);
  assert.equal((await frames.get('02-party')).id, '02-party');
  assert.equal(await frames.get('nope'), null);
  assert.equal(await frames.get(null), null);
});

test('labelFromFile: order prefix and separators removed', () => {
  assert.equal(frames.labelFromFile('/x/03_my-nice_frame.png'), 'My nice frame');
  assert.equal(frames.labelFromFile('gold.svg'), 'Gold');
});

test('today: date written out in the language', () => {
  assert.match(frames.today('fr-FR'), /^\d{1,2} \p{L}+ \d{4}$/u);
  assert.match(frames.today('en-GB'), /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
});

test('fitTexts: a long title gets a smaller font, a short one is kept', () => {
  const svg = (text) => `<text x="0" data-fit="500" font-size="46">${text}</text>`;
  // data-fit is a hint for the server only: it is removed from the rendered SVG
  assert.equal(frames.fitTexts(svg('Hi')), '<text x="0" font-size="46.0">Hi</text>');
  const long = frames.fitTexts(svg('x'.repeat(40)));
  const size = Number(long.match(/font-size="([\d.]+)"/)[1]);
  assert.ok(size < 46 && Math.abs(size - 500 / (0.6 * 40)) < 0.1, String(size));
  // custom character width, entities count as one character
  const fitted = frames.fitTexts('<text data-fit="100" data-char-width="1" font-size="50">a&amp;b</text>');
  assert.match(fitted, /font-size="33\.3"/);
});

test('opaqueParts: transparent areas left out, the rest is pixel-identical', async () => {
  // 1000 × 600 layer: opaque 40 px border, a dot in the middle, transparent elsewhere
  const w = 1000, h = 600, data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x < 40 || y < 40 || x >= w - 40 || y >= h - 40;
      const dot = Math.abs(x - 500) < 3 && Math.abs(y - 300) < 3;
      if (border || dot) data.set([x % 256, y % 256, 100, border ? 255 : 128], (y * w + x) * 4);
    }
  }
  const parts = frames.opaqueParts({ data, info: { width: w, height: h, channels: 4 } });
  const kept = parts.reduce((n, p) => n + p.input.length, 0);
  assert.ok(kept < data.length * 0.6, `kept ${kept} of ${data.length} bytes`);
  for (const p of parts) assert.ok(p.left >= 0 && p.top >= 0 && p.left + p.raw.width <= w && p.top + p.raw.height <= h);
  const back = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts)
    .raw()
    .toBuffer();
  assert.ok(back.equals(data), 'recomposed layer differs from the original');
  assert.deepEqual(frames.opaqueParts({ data: Buffer.alloc(64 * 64 * 4), info: { width: 64, height: 64, channels: 4 } }), []);
});

test('apply: frame on a colour photo, same size, colours kept', async () => {
  const src = await testPhoto('colour.jpg');
  const dst = path.join(tmp, 'colour-out.jpg');
  await apply({ ...(await frames.get('02-party')), ...opts }, src, dst);
  const m = await sharp(dst).metadata();
  assert.deepEqual([m.width, m.height, m.format], [1200, 800, 'jpeg']);
  const [r, , b] = await pixel(dst, 300, 400);
  assert.ok(r > 150 && b < 100, 'red half still red');
});

test('apply: black & white photo, frame still in colour', async () => {
  const src = await testPhoto('bw.jpg');
  const dst = path.join(tmp, 'bw-out.jpg');
  const frame = { ...(await frames.get('02-party')), ...opts };
  await apply(frame, src, dst, { bw: true });
  const [r, g, b] = await pixel(dst, 300, 400);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 3, `photo is grey: ${r},${g},${b}`);
  const border = await pixel(dst, 4, 400); // rainbow border of the Party frame
  assert.ok(Math.max(...border) - Math.min(...border) > 60, `frame keeps its colours: ${border}`);
});

test('apply: EXIF orientation applied (portrait photo stays portrait)', async () => {
  const dst = path.join(tmp, 'rotated-out.jpg');
  await apply({ ...(await frames.get('01-polaroid')), ...opts }, await testPhoto('rotated.jpg', { orientation: 6 }), dst);
  const m = await sharp(dst).metadata();
  assert.deepEqual([m.width, m.height], [800, 1200]);
});

test('apply: screen version limited to maxSize, never enlarged', async () => {
  const src = await testPhoto('small.jpg');
  const frame = { ...(await frames.get('03-cinema')), ...opts };
  await apply(frame, src, path.join(tmp, 'max.jpg'), { maxSize: 600, quality: 80 });
  const m = await sharp(path.join(tmp, 'max.jpg')).metadata();
  assert.deepEqual([m.width, m.height], [600, 400]);
  await apply(frame, src, path.join(tmp, 'big.jpg'), { maxSize: 3840 });
  const big = await sharp(path.join(tmp, 'big.jpg')).metadata();
  assert.deepEqual([big.width, big.height], [1200, 800]);
});

test('apply: same output on every call (cached frame layers)', async () => {
  const src = await testPhoto('cache.jpg');
  const frame = { ...(await frames.get('04-elegant')), ...opts };
  await apply(frame, src, path.join(tmp, 'c1.jpg'), { decorations: BIRTHDAY });
  await apply(frame, src, path.join(tmp, 'c2.jpg'), { decorations: BIRTHDAY });
  assert.ok(fs.readFileSync(path.join(tmp, 'c1.jpg')).equals(fs.readFileSync(path.join(tmp, 'c2.jpg'))));
});

test('preview: transparent PNG of the requested size', async () => {
  const png = await frames.preview(await frames.get('01-polaroid'), opts);
  const m = await sharp(png).metadata();
  assert.deepEqual([m.format, m.width, m.height, m.channels], ['png', 1200, 800, 4]);
});

test('settings: frame and title added to the app settings, cleaned up', async () => {
  let s = settings.load();
  assert.deepEqual([s.frame, s.frameTitle], [null, 'Our party']);
  s = await settings.update({ frame: '../../etc/passwd', frameTitle: `  Happy   birthday\n ${'x'.repeat(100)}` });
  assert.equal(s.frame, null);
  assert.equal(s.frameTitle.length, MAX_TITLE);
  assert.match(s.frameTitle, /^Happy birthday x+$/);
});

test('hooks: frame of a shot, checked settings, journal entries', async () => {
  const feature = def('frames');
  await settings.update({ frame: null, frameTitle: 'Party', photoDeco: false });
  assert.equal(await feature.forShot(settings.get()), null);
  assert.deepEqual(await features.forShot(settings.get(), {}), {}, 'nothing to do for a photo');
  await settings.update({ frame: '02-party' });
  const frame = await feature.forShot(settings.get());
  assert.deepEqual([frame.id, frame.label, frame.title, frame.locale], ['02-party', 'Party', 'Party', 'en-GB']);
  assert.deepEqual(feature.journalDetail(frame), { key: 'frames.journal.with', vars: { frame: 'Party' } });
  assert.deepEqual(await feature.settingsPatch({ frame: 'nope' }), { error: 'Unknown frame.' });
  assert.deepEqual(await feature.settingsPatch({ frame: '', frameTitle: 'Hi', mirror: true }), { patch: { frame: null, frameTitle: 'Hi' } });
  const added = [];
  await feature.journalSettings({ frame: null, frameTitle: 'a' }, { frame: '01-polaroid', frameTitle: 'b' }, (k, v) => added.push([k, v]));
  assert.deepEqual(added, [['frames.journal.settingFrame', { value: 'Polaroid' }], ['frames.journal.settingTitle', { value: 'b' }]]);
});
