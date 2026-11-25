'use strict';

// Real shots, one at a time: files written, versions served, colours, live view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  REAL, fakeOnly, photos, startServer, shoot, waitFullSize, media, orientedSize, colourAt, isGrey, waitFor,
} = require('./helpers');

let server;
test.before(async () => { server = await startServer('shots'); });
test.after(() => server.stop());

/** Checks everything a processed photo (frame and/or black & white) must have. */
async function checkProcessed(shot) {
  const { name } = shot.photo;
  await waitFullSize(server, name);
  const original = path.join(server.originalsDir, name);
  const final = path.join(server.photosDir, name);
  assert.ok(fs.existsSync(original), 'original kept in originals/');
  if (!REAL) assert.ok(fs.readFileSync(original).equals(fs.readFileSync(fs.readFileSync(`${server.camera.dir}/photo`, 'utf8'))), 'original untouched');
  // full size, the right way up
  assert.deepEqual(await orientedSize(final), await orientedSize(original));
  // dated from the shot (gallery order)
  assert.ok(Math.abs(fs.statSync(final).mtimeMs - Date.parse(shot.photo.date)) < 5, 'file time = time of the shot');
  assert.deepEqual(fs.readdirSync(server.cacheDir).filter((f) => f.startsWith('pending_')), []);
  assert.deepEqual(fs.readdirSync(server.photosDir).filter((f) => f.endsWith('.tmp')), []);
  await checkServed(shot.photo, final);
  return final;
}

/** Thumbnail, tablet and TV versions served, with their size, never cached by the browser. */
async function checkServed(dto, file) {
  const [w, h] = await orientedSize(file);
  const long = Math.max(w, h);
  for (const [kind, max] of [['thumb', 480], ['view', 1920], ['tv', 3840]]) {
    const m = await media(server, dto[kind]);
    assert.equal(m.status, 200, kind);
    assert.equal(Math.max(m.meta.width, m.meta.height), Math.min(max, long), `${kind} size`);
    assert.equal(m.meta.width > m.meta.height, w > h, `${kind} orientation`);
    assert.match(m.headers.get('cache-control'), /no-store/, `${kind} cache`);
  }
}

test('photo without frame', async () => {
  await server.settings({ frame: null });
  const shot = await shoot(server, { label: 'no frame' });
  assert.equal(shot.status, 202);
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.photo, 'photo event');
  const file = path.join(server.photosDir, shot.photo.name);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(server.originalsDir, shot.photo.name)), 'nothing to keep aside');
  await checkServed(shot.photo, file);
  const list = await server.json('/api/photos');
  assert.equal(list[0].name, shot.photo.name);
});

test('photo with a frame, in colour', async () => {
  await server.settings({ frame: '01-polaroid', frameTitle: 'Functional tests', frameDeco: false });
  const shot = await shoot(server, { label: 'frame, colour' });
  assert.deepEqual(shot.errors, []);
  const final = await checkProcessed(shot);
  if (!REAL) {
    const red = await colourAt(final, 0.2, 0.5);
    assert.ok(red[0] > 150 && red[2] < 100, `red half still red: ${red}`);
  }
});

test('photo with a frame, in black & white (the frame keeps its colours)', async () => {
  await server.settings({ frame: '02-party' });
  const shot = await shoot(server, { bw: true, label: 'frame, B&W' });
  assert.deepEqual(shot.errors, []);
  const final = await checkProcessed(shot);
  for (const [x, y] of [[0.3, 0.4], [0.5, 0.5], [0.7, 0.6]]) assert.ok(isGrey(await colourAt(final, x, y)), `grey at ${x},${y}`);
  const border = await colourAt(final, 0.002, 0.5); // rainbow border of the Party frame
  assert.ok(!isGrey(border), `frame in colour: ${border}`);
});

test('photo with a frame and the theme decorations', async () => {
  await server.settings({ frame: '02-party', theme: 'birthday', frameDeco: true });
  const shot = await shoot(server, { label: 'frame + decorations' });
  assert.deepEqual(shot.errors, []);
  await checkProcessed(shot);
  await server.settings({ frameDeco: false });
});

test('camera held upright: portrait photo, the right way up', { skip: fakeOnly }, async () => {
  server.camera.photo(await photos.rotated());
  await server.settings({ frame: '01-polaroid' });
  const shot = await shoot(server);
  const final = await checkProcessed(shot);
  const [w, h] = await orientedSize(final);
  assert.ok(h > w, 'portrait');
  server.camera.photo(await photos.p10());
});

test('RAW+JPEG: both files kept aside, only the JPEG in the gallery', { skip: fakeOnly }, async () => {
  server.camera.raw(true);
  const shot = await shoot(server);
  server.camera.raw(false);
  await checkProcessed(shot);
  const base = shot.photo.name.replace(/\.jpg$/, '');
  assert.ok(fs.existsSync(path.join(server.originalsDir, `${base}.cr2`)), 'RAW kept in originals/');
  assert.ok(!fs.readdirSync(server.photosDir).some((f) => f.endsWith('.cr2')), 'no RAW in the gallery folder');
  assert.ok(!(await server.json('/api/photos')).some((p) => p.name.endsWith('.cr2')));
});

test('frame that cannot be applied: photo saved as is, with a message', { skip: fakeOnly }, async () => {
  // a frame whose file is broken: the photo must not be lost
  const framesDir = path.join(server.dirs.base, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(path.join(framesDir, '09-broken.png'), 'not a png');
  const other = await startServer('broken-frame', { env: { FRAMES_DIR: framesDir } });
  try {
    await other.settings({ frame: '09-broken' });
    const shot = await shoot(other);
    assert.ok(shot.photo, 'photo still shown');
    assert.deepEqual(shot.errors, ['The photo could not be edited: it was saved as is.']);
    const file = path.join(other.photosDir, shot.photo.name);
    assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(other.originalsDir, shot.photo.name))), 'photo as is');
  } finally {
    await other.stop();
  }
});

test('a second photo while one is in progress is refused', async () => {
  await server.settings({ frame: null });
  const first = server.api('/api/shoot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const second = await server.api('/api/shoot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await first).status, 202);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'A photo is already in progress.');
  await waitFor(async () => !(await server.status()).busy, { timeout: 60000, what: 'the end of the shot' });
});

test('live view during the countdown, stopped for the capture', async () => {
  await server.settings({ live: true, frame: '01-polaroid' });
  const from = server.events.list.length;
  const done = shoot(server, { label: 'frame + live view' });
  // the tablet opens the MJPEG stream once live view is on
  await waitFor(() => server.events.list.slice(from).some((e) => e.type === 'live' && e.state === 'on'), { timeout: 20000, what: 'live view' });
  const res = await server.api('/api/live.mjpeg');
  assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);
  let frames = 0;
  for await (const chunk of res.body) frames += String(Buffer.from(chunk)).split('--flashandfuriousframe').length - 1;
  const shot = await done;
  await server.settings({ live: false });
  assert.deepEqual(shot.errors, []);
  assert.ok(frames >= 3, `${frames} live frames received`);
  const states = shot.events.filter((e) => e.type === 'live').map((e) => e.state);
  assert.deepEqual([states[0], states.at(-1)], ['starting', 'off']);
  const phases = shot.events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.ok(phases.indexOf('preparing') < phases.indexOf('capturing'), phases.join(' > '));
  await checkProcessed(shot);
});

test('nothing kept by the browsers: no-store on pages, API and photos', async () => {
  const [p] = await server.json('/api/photos');
  for (const url of ['/', '/admin', '/slideshow', '/app.js', '/api/photos', '/api/status', '/api/frames/01-polaroid.png', p.thumb, p.view, p.tv]) {
    const res = await server.api(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('cache-control'), /no-store/, url);
  }
  assert.equal((await server.api('/photos/x.jpg')).status, 404, 'no direct access to the photos folder');
  assert.equal((await server.api(`/media/view/${encodeURIComponent('../config/settings.json')}`)).status, 400);
});
