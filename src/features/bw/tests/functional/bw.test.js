'use strict';

// Black & white module: chosen per shot on the tablet, the whole photo turns grey.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, shoot, waitFullSize, colourAt, isGrey } = require('../../../../../tests/functional/helpers');

let server;
test.before(async () => { server = await startServer('bw'); });
test.after(() => server.stop());

test('photo in black & white: tablet told, grey at full size, in the journal', async () => {
  const shot = await shoot(server, { bw: true, label: 'B&W' });
  assert.deepEqual(shot.errors, []);
  assert.ok(shot.events.some((e) => e.type === 'phase' && e.phase === 'editing' && e.message === 'Converting to black & white…'), 'tablet told');
  await waitFullSize(server, shot.photo.name);
  const final = path.join(server.photosDir, shot.photo.name);
  for (const [x, y] of [[0.3, 0.4], [0.5, 0.5], [0.7, 0.6]]) assert.ok(isGrey(await colourAt(final, x, y)), `grey at ${x},${y}`);
  const [last] = (await server.json('/api/journal?limit=1')).entries;
  assert.equal(last.message, 'Photo taken: black & white');
});

test('not asked: the photo stays as taken', async () => {
  const shot = await shoot(server, { bw: false });
  assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
});

test('switched off (not in FEATURES): asked by an old tablet page, ignored', async () => {
  const off = await startServer('bw-off', { env: { FEATURES: 'decorations' } });
  try {
    assert.equal((await off.api('/features/bw/booth.js')).status, 404);
    const shot = await shoot(off, { bw: true });
    assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
  } finally {
    await off.stop();
  }
});
