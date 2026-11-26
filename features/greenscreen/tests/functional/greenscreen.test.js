'use strict';

// Green screen: calibration, backgrounds, photos with the cloth replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { REAL, FIXTURES, photos: testPhotos, startServer, shoot, waitFullSize, media, colourAt, isGrey, WORK } = require('../../../../tests/functional/helpers');

/**
 * Green screen test photo: green cloth, a little darker at the bottom, with a skin-coloured
 * "person" in the middle (40-60 % of the width, from 25 % of the height), light noise.
 */
async function greenFixture(name, width, height) {
  const file = path.join(FIXTURES, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(FIXTURES, { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2cb44a"/><stop offset="1" stop-color="#249a3e"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#l)"/>
    <rect x="40%" y="25%" width="20%" height="75%" rx="${Math.round(width / 40)}" fill="#e1af91"/></svg>`;
  const noise = await sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 8 } } })
    .png()
    .toBuffer();
  await sharp(await sharp(Buffer.from(svg)).composite([{ input: noise, blend: 'soft-light' }]).png().toBuffer())
    .jpeg({ quality: 92 })
    .toFile(`${file}.tmp`);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}
const photos = { ...testPhotos, green: () => greenFixture('green.jpg', 3888, 2592) };

// the real camera does not see a green cloth: these tests need the fake one
const skip = REAL && 'needs the fake camera (green cloth photo)';

const MAGENTA = [200, 30, 200];
const CYAN = [30, 200, 220];
const SKIN = [225, 175, 145];
const near = (a, b, d = 20) => a.every((v, i) => Math.abs(v - b[i]) <= d);

let server;
let bgDir;
test.before(async () => {
  if (skip) return;
  // plain backgrounds: their colour is easy to check on the photos
  bgDir = fs.mkdtempSync(path.join(WORK, 'backgrounds-'));
  for (const [name, [r, g, b]] of [['1-magenta', MAGENTA], ['2-cyan', CYAN]]) {
    await sharp({ create: { width: 600, height: 400, channels: 3, background: { r, g, b } } }).png().toFile(path.join(bgDir, `${name}.png`));
  }
  server = await startServer('greenscreen', { env: { BACKGROUNDS_DIR: bgDir } });
});
test.after(() => server && server.stop());

const lastJournal = async () => (await server.json('/api/journal?limit=1')).entries[0];
const calibrate = () => server.api('/api/greenscreen/calibrate', { method: 'POST' });

test('backgrounds listed, the first one chosen by default, thumbnails served', { skip }, async () => {
  const list = await server.json('/api/backgrounds');
  assert.deepEqual(list.map((b) => [b.id, b.label]), [['1-magenta', 'Magenta'], ['2-cyan', 'Cyan']]);
  const thumb = await media(server, list[0].preview);
  assert.deepEqual([thumb.status, thumb.meta.format, thumb.meta.width], [200, 'jpeg', 600]);
  const s = await server.json('/api/settings');
  assert.deepEqual([s.greenScreen, s.background.id, s.greenKey, s.greenPreview], [false, '1-magenta', null, null]);
});

test('calibration without a green cloth: clear message, nothing saved', { skip }, async () => {
  server.camera.photo(await photos.p10()); // red / blue photo
  const res = await calibrate();
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /No green cloth found: only \d+% of the photo is green/);
  assert.equal((await server.json('/api/settings')).greenKey, null);
  const entry = await lastJournal();
  assert.equal(entry.level, 'error');
  assert.match(entry.message, /^Green screen calibration failed: No green cloth found/);
});

test('calibration: measured, preview of the result, nothing added to the gallery', { skip }, async () => {
  server.camera.photo(await photos.green());
  const before = await server.json('/api/photos');
  const shots = server.camera.calls('--capture-image').length;
  const res = await calibrate();
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.ok(s.greenKey.coverage > 70 && s.greenKey.coverage < 90, `coverage ${s.greenKey.coverage}`);
  assert.ok(Date.now() - s.greenKey.at < 60000);
  assert.equal(server.camera.calls('--capture-image').length, shots + 1, 'one photo');
  assert.deepEqual(await server.json('/api/photos'), before, 'gallery unchanged');
  assert.deepEqual(fs.readdirSync(server.cacheDir).filter((f) => f.startsWith('calibration')), [], 'temporary files removed');
  assert.match((await lastJournal()).message, /^Green screen calibrated \(\d+% of the photo is green cloth\)$/);
  // preview: the calibration photo with the cloth replaced
  const file = path.join(server.dirs.base, 'preview.jpg');
  fs.writeFileSync(file, Buffer.from(await (await server.api(s.greenPreview)).arrayBuffer()));
  assert.ok(near(await colourAt(file, 0.1, 0.1), MAGENTA), 'background in the preview');
  assert.ok(near(await colourAt(file, 0.5, 0.6), SKIN), 'person in the preview');
});

test('photo: cloth replaced on every version, original kept as is', { skip }, async () => {
  await server.settings({ greenScreen: true, background: '2-cyan' });
  const shot = await shoot(server, { label: 'green screen' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.events.some((e) => e.type === 'phase' && e.phase === 'editing' && e.message === 'Adding the background…'), 'tablet told');
  const { name } = shot.photo;
  await waitFullSize(server, name);
  const final = path.join(server.photosDir, name);
  for (const [fx, fy] of [[0.05, 0.05], [0.9, 0.5], [0.2, 0.95]]) assert.ok(near(await colourAt(final, fx, fy), CYAN), `background at ${fx},${fy}`);
  assert.ok(near(await colourAt(final, 0.5, 0.6), SKIN), 'person kept');
  const original = path.join(server.originalsDir, name);
  assert.ok(fs.readFileSync(original).equals(fs.readFileSync(await photos.green())), 'original untouched');
  // tablet version too
  const view = path.join(server.dirs.base, 'view.jpg');
  fs.writeFileSync(view, Buffer.from(await (await server.api(shot.photo.view)).arrayBuffer()));
  assert.ok(near(await colourAt(view, 0.05, 0.05), CYAN));
  const entry = await lastJournal();
  assert.equal(entry.message, 'Photo taken: “Cyan” background');
  assert.equal(entry.detail, name);
});

test('photo in black & white with the theme decorations: background in grey, drawings in colour', { skip }, async () => {
  await server.settings({ theme: 'birthday', photoDeco: true });
  const shot = await shoot(server, { bw: true, label: 'green screen + decorations, B&W' });
  await waitFullSize(server, shot.photo.name);
  const final = path.join(server.photosDir, shot.photo.name);
  const bg = await colourAt(final, 0.2, 0.3);
  assert.ok(isGrey(bg), `background grey: ${bg}`);
  const corner = [];
  for (let x = 0.02; x < 0.25; x += 0.02) corner.push(await colourAt(final, x, 0.9));
  assert.ok(corner.some((c) => !isGrey(c)), 'drawing in colour');
  assert.equal((await lastJournal()).message, 'Photo taken: “Cyan” background, theme decorations, black & white');
  await server.settings({ photoDeco: false });
});

test('settings: checked, and written in the journal', { skip }, async () => {
  assert.equal((await server.api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"background":"nope"}' })).status, 400);
  assert.equal((await server.api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"greenTolerance":150}' })).status, 400);
  await server.settings({ background: '1-magenta', greenTolerance: 70, greenScreen: false });
  const recent = (await server.json('/api/journal?limit=3')).entries.map((e) => e.message);
  assert.deepEqual(recent.sort(), ['Green screen background: Magenta', 'Green screen tolerance: 70', 'Green screen: off'].sort());
  // off: photos as usual
  server.camera.photo(await photos.green());
  const shot = await shoot(server);
  const file = path.join(server.photosDir, shot.photo.name);
  assert.ok(!near(await colourAt(file, 0.05, 0.05), MAGENTA), 'cloth kept');
});

test('switched off (not in FEATURES): no routes, no settings for /admin, photos never changed', { skip }, async () => {
  const off = await startServer('greenscreen-off', { env: { BACKGROUNDS_DIR: bgDir, FEATURES: 'bw,decorations,frames' } });
  try {
    for (const url of ['/api/backgrounds', '/api/greenscreen/preview.jpg', '/features/greenscreen/admin.js']) assert.equal((await off.api(url)).status, 404, url);
    assert.equal((await off.api('/api/greenscreen/calibrate', { method: 'POST' })).status, 404);
    const s = await off.settings({ greenScreen: true, background: 'nope' }); // ignored, not refused
    for (const k of ['greenScreen', 'background', 'greenTolerance', 'greenKey', 'greenPreview']) assert.ok(!(k in s), `no ${k}`);
    off.camera.photo(await photos.green());
    const shot = await shoot(off);
    assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
    assert.ok(!near(await colourAt(path.join(off.photosDir, shot.photo.name), 0.05, 0.05), MAGENTA), 'cloth kept');
  } finally {
    await off.stop();
  }
});
