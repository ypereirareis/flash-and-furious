'use strict';

// Photos in a row: the tablet only waits for the 1920 px version, the full-size photos follow
// in a queue, one at a time and in order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REAL, photos, startServer, shoot, waitFullSize } = require('./helpers');

let server;
test.before(async () => {
  // no countdown: the next shot starts while the previous full-size photo is being computed
  server = await startServer('queue', { env: { DEFAULT_DELAY: '0' } });
  if (!REAL) server.camera.photo(await photos.p24());
  await server.settings({ theme: 'christmas', photoDeco: true }); // every photo edited
});
test.after(() => server.stop());

test('burst of photos: each one shown at once, full sizes computed in order', async () => {
  const shots = [];
  const pendingSeen = new Set();
  for (let i = 0; i < (REAL ? 3 : 4); i++) {
    const shot = await shoot(server, { bw: i === 1, label: REAL ? 'burst' : 'burst (24 Mpx)' });
    assert.deepEqual(shot.errors, []);
    assert.ok(shot.photo);
    shots.push(shot.photo);
    // listed (and its tablet version served) even while its full size is not written yet
    if (!fs.existsSync(path.join(server.photosDir, shot.photo.name))) {
      pendingSeen.add(shot.photo.name);
      const list = await server.json('/api/photos');
      assert.ok(list.some((p) => p.name === shot.photo.name), 'pending photo listed');
      assert.equal((await server.api(shot.photo.view)).status, 200);
    }
  }
  for (const p of shots) await waitFullSize(server, p.name);
  if (!REAL) assert.ok(pendingSeen.size > 0, 'the queue was used');
  // gallery order = shot order, whatever the order the full sizes were written in
  const list = (await server.json('/api/photos')).map((p) => p.name);
  assert.deepEqual(list.slice(0, shots.length), shots.map((p) => p.name).reverse());
  for (const p of shots) {
    assert.ok(Math.abs(fs.statSync(path.join(server.photosDir, p.name)).mtimeMs - Date.parse(p.date)) < 5);
  }
  assert.deepEqual(fs.readdirSync(server.cacheDir).filter((f) => f.startsWith('pending_')), []);
  // order of the queue, from the server logs
  const done = server.logs.map((l) => l.match(/\[photo\] (\S+): full size in/)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(done, shots.map((p) => p.name));
});

test('TV version of a photo still in the queue: served once the full size is ready', async () => {
  const shot = await shoot(server);
  const res = await server.api(shot.photo.tv); // waits for the full size if needed
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(server.photosDir, shot.photo.name)));
});
