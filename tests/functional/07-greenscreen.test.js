'use strict';

// Green screen: calibration, backgrounds, photos with the cloth replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { REAL, photos, startServer, shoot, waitFullSize, media, colourAt, isGrey, WORK } = require('./helpers');

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
  await server.settings({ greenScreen: true, background: '2-cyan', frame: null });
  const shot = await shoot(server, { label: 'green screen' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.events.some((e) => e.type === 'phase' && e.phase === 'framing' && e.green), 'tablet told');
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
  assert.equal(entry.message, 'Photo taken on the “Cyan” background');
  assert.equal(entry.detail, name);
});

test('photo with a frame in black & white: background in grey, frame in colour', { skip }, async () => {
  await server.settings({ frame: '02-party' });
  const shot = await shoot(server, { bw: true, label: 'green screen + frame, B&W' });
  await waitFullSize(server, shot.photo.name);
  const final = path.join(server.photosDir, shot.photo.name);
  const bg = await colourAt(final, 0.2, 0.3);
  assert.ok(isGrey(bg), `background grey: ${bg}`);
  assert.ok(!isGrey(await colourAt(final, 0.002, 0.5)), 'frame in colour');
  assert.equal((await lastJournal()).message, 'Photo taken in black & white on the “Cyan” background with the “Party” frame');
  await server.settings({ frame: null });
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
