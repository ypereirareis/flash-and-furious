'use strict';

// Theme decorations module: the theme's drawings on a photo without frame, in colour over
// black & white; its setting in /admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, shoot, waitFullSize, colourAt, isGrey } = require('../../../../tests/functional/helpers');

let server;
test.before(async () => { server = await startServer('decorations'); });
test.after(() => server.stop());

test('theme decorations on a photo without frame, in colour over black & white', async () => {
  await server.settings({ theme: 'birthday', photoDeco: true });
  const shot = await shoot(server, { bw: true, label: 'decorations, B&W' });
  assert.deepEqual(shot.errors, []);
  await waitFullSize(server, shot.photo.name);
  const final = path.join(server.photosDir, shot.photo.name);
  const corner = [];
  for (let x = 0.02; x < 0.25; x += 0.02) corner.push(await colourAt(final, x, 0.9));
  assert.ok(corner.some((c) => !isGrey(c)), 'drawing in colour in the bottom-left corner');
  assert.ok(isGrey(await colourAt(final, 0.6, 0.5)), 'photo in grey');
  const [last] = (await server.json('/api/journal?limit=1')).entries;
  assert.equal(last.message, 'Photo taken: theme decorations, black & white');
});

test('theme without decorations: nothing to add', async () => {
  await server.settings({ theme: 'night', photoDeco: true });
  const shot = await shoot(server);
  assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
});

test('setting: sent to the screens, one journal entry per change', async () => {
  assert.equal((await server.settings({ photoDeco: false })).photoDeco, false);
  await server.settings({ photoDeco: true });
  const recent = (await server.json('/api/journal?limit=2')).entries.map((e) => e.message);
  assert.deepEqual(recent, ['Theme decorations on photos: on', 'Theme decorations on photos: off']);
  await server.settings({ photoDeco: false });
});
