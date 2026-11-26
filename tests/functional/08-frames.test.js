'use strict';

// Frames (optional feature, server/frames/): photos with a frame, previews, settings, FRAMES=off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REAL, fakeOnly, startServer, shoot, waitFullSize, media, orientedSize, colourAt, isGrey } = require('./helpers');

let server;
test.before(async () => { server = await startServer('frames'); });
test.after(() => server.stop());

const lastJournal = async (s = server) => (await s.json('/api/journal?limit=1')).entries[0];
/** Full-size photo of a shot, once written; original kept aside, same size. */
async function finalFile(shot, s = server) {
  await waitFullSize(s, shot.photo.name);
  const final = path.join(s.photosDir, shot.photo.name);
  const original = path.join(s.originalsDir, shot.photo.name);
  assert.ok(fs.existsSync(original), 'original kept in originals/');
  assert.deepEqual(await orientedSize(final), await orientedSize(original));
  return final;
}

test('frames listed with their previews, never cached by the browser', async () => {
  const list = await server.json('/api/frames');
  assert.deepEqual(list.map((f) => f.id), ['01-polaroid', '02-party', '03-cinema', '04-elegant']);
  const preview = await media(server, list[1].preview);
  assert.deepEqual([preview.status, preview.meta.format, preview.meta.width], [200, 'png', 1200]);
  assert.match(preview.headers.get('cache-control'), /no-store/);
  assert.equal((await server.api('/api/frames/nope.png')).status, 404);
});

test('photo with a frame, in colour', async () => {
  const s = await server.settings({ frame: '01-polaroid', frameTitle: 'Functional tests' });
  assert.deepEqual([s.frame.id, s.frameTitle], ['01-polaroid', 'Functional tests']);
  const shot = await shoot(server, { label: 'frame, colour' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.events.some((e) => e.type === 'phase' && e.phase === 'framing' && e.message === 'Adding the frame…'), 'tablet told');
  const final = await finalFile(shot);
  if (!REAL) {
    const red = await colourAt(final, 0.2, 0.5);
    assert.ok(red[0] > 150 && red[2] < 100, `red half still red: ${red}`);
  }
  assert.equal((await lastJournal()).message, 'Photo taken: “Polaroid” frame');
});

test('photo with a frame, in black & white (the frame keeps its colours)', async () => {
  await server.settings({ frame: '02-party' });
  const shot = await shoot(server, { bw: true, label: 'frame, B&W' });
  assert.deepEqual(shot.errors, []);
  const final = await finalFile(shot);
  for (const [x, y] of [[0.3, 0.4], [0.5, 0.5], [0.7, 0.6]]) assert.ok(isGrey(await colourAt(final, x, y)), `grey at ${x},${y}`);
  assert.ok(!isGrey(await colourAt(final, 0.002, 0.5)), 'rainbow border of the Party frame in colour');
  assert.equal((await lastJournal()).message, 'Photo taken: “Party” frame, black & white');
});

test('photo with a frame and the theme decorations', async () => {
  await server.settings({ frame: '02-party', theme: 'birthday', photoDeco: true });
  const shot = await shoot(server, { label: 'frame + decorations' });
  assert.deepEqual(shot.errors, []);
  await finalFile(shot);
  assert.equal((await lastJournal()).message, 'Photo taken: “Party” frame, theme decorations');
  await server.settings({ photoDeco: false });
});

test('settings: checked, and written in the journal', async () => {
  const put = (body) => server.api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const res = await put({ frame: 'nope' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Unknown frame.');
  await server.settings({ frame: '04-elegant', frameTitle: 'Coucou Marjo' });
  await server.settings({ frame: null });
  const recent = (await server.json('/api/journal?limit=3')).entries.map((e) => e.message);
  assert.deepEqual(recent, ['Frame: none', 'Frame text: “Coucou Marjo”', 'Frame: Elegant']);
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

test('FRAMES=off: no routes, no settings for the screens, photos never framed', { skip: fakeOnly }, async () => {
  const off = await startServer('frames-off', { env: { FRAMES: 'off' } });
  try {
    for (const url of ['/api/frames', '/api/frames/01-polaroid.png']) assert.equal((await off.api(url)).status, 404, url);
    const s = await off.settings({ frame: '02-party', frameTitle: 'x' }); // ignored, not refused
    for (const k of ['frame', 'frameTitle']) assert.ok(!(k in s), `no ${k}`);
    const shot = await shoot(off);
    assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'framing'), 'no processing');
    assert.equal((await lastJournal(off)).message, 'Photo taken');
  } finally {
    await off.stop();
  }
});
