'use strict';

// Real shots, one at a time: files written, versions served, colours, live view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  REAL, fakeOnly, photos, startServer, shoot, waitFullSize, media, orientedSize, colourAt, waitFor,
} = require('./helpers');

let server;
test.before(async () => { server = await startServer('shots'); });
test.after(() => server.stop());

/** Checks everything an edited photo must have (edited by the test module, modules/testedit). */
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

test('photo as taken', async () => {
  const shot = await shoot(server, { label: 'as taken' });
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

test('edited photo: original kept aside, edited version at full size', async () => {
  const shot = await shoot(server, { testEdit: true, label: 'edited' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.events.some((e) => e.type === 'phase' && e.phase === 'editing' && e.message === 'Test edit…'), 'tablet told');
  const final = await checkProcessed(shot);
  if (!REAL) {
    const [r, , b] = await colourAt(final, 0.2, 0.2); // red half of the test photo, negated by the test module
    assert.ok(r < 100 && b > 150, `edited: ${[r, b]}`);
  }
});

test('camera held upright: portrait photo, the right way up', { skip: fakeOnly }, async () => {
  server.camera.photo(await photos.rotated());
  const shot = await shoot(server, { testEdit: true });
  const final = await checkProcessed(shot);
  const [w, h] = await orientedSize(final);
  assert.ok(h > w, 'portrait');
  server.camera.photo(await photos.p10());
});

test('RAW+JPEG: both files kept aside, only the JPEG in the gallery', { skip: fakeOnly }, async () => {
  server.camera.raw(true);
  const shot = await shoot(server, { testEdit: true });
  server.camera.raw(false);
  await checkProcessed(shot);
  const base = shot.photo.name.replace(/\.jpg$/, '');
  assert.ok(fs.existsSync(path.join(server.originalsDir, `${base}.cr2`)), 'RAW kept in originals/');
  assert.ok(!fs.readdirSync(server.photosDir).some((f) => f.endsWith('.cr2')), 'no RAW in the gallery folder');
  assert.ok(!(await server.json('/api/photos')).some((p) => p.name.endsWith('.cr2')));
});

test('a second photo while one is in progress is refused', async () => {
  const first = server.api('/api/shoot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const second = await server.api('/api/shoot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await first).status, 202);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'A photo is already in progress.');
  await waitFor(async () => !(await server.status()).busy, { timeout: 60000, what: 'the end of the shot' });
});

test('live view during the countdown, stopped for the capture', async () => {
  await server.settings({ live: true });
  const from = server.events.list.length;
  const done = shoot(server, { testEdit: true, label: 'live view, edited' });
  // the tablet opens the MJPEG stream once live view is on
  await waitFor(() => server.events.list.slice(from).some((e) => e.type === 'live' && e.state === 'on'), { timeout: 20000, what: 'live view' });
  const res = await server.api('/api/live.mjpeg');
  assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);
  let frames = 0;
  for await (const chunk of res.body) frames += String(Buffer.from(chunk)).split('--flashandfuriousframe').length - 1;
  const shot = await done;
  await server.settings({ live: false });
  assert.deepEqual(shot.errors, []);
  // 1 s countdown in the tests: the real camera takes about that long to start its live view
  assert.ok(frames >= (REAL ? 1 : 3), `${frames} live frames received`);
  const states = shot.events.filter((e) => e.type === 'live').map((e) => e.state);
  assert.deepEqual([states[0], states.at(-1)], ['starting', 'off']);
  const phases = shot.events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.ok(phases.indexOf('preparing') < phases.indexOf('capturing'), phases.join(' > '));
  await checkProcessed(shot);
});

test('nothing kept by the browsers: no-store on pages, API and photos', async () => {
  const [p] = await server.json('/api/photos');
  for (const url of ['/', '/admin', '/slideshow', '/app.js', '/api/photos', '/api/status', p.thumb, p.view, p.tv]) {
    const res = await server.api(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('cache-control'), /no-store/, url);
  }
  assert.equal((await server.api('/photos/x.jpg')).status, 404, 'no direct access to the photos folder');
  assert.equal((await server.api(`/media/view/${encodeURIComponent('../config/settings.json')}`)).status, 400);
});
