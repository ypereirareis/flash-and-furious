'use strict';

// Stops during processing: no photo lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REAL, photos, startServer, shoot, waitFor, waitFullSize } = require('./helpers');

const pending = (server) => fs.readdirSync(server.cacheDir).filter((f) => f.startsWith('pending_'));

/** Shoots and stops the server with `signal` as soon as the photo is shown. */
async function shootThenStop(server, signal) {
  const from = server.events.list.length;
  const shot = shoot(server, { bw: true });
  await waitFor(() => server.events.list.slice(from).some((e) => e.type === 'photo'), { timeout: 60000, what: 'the photo' });
  const name = server.events.list.slice(from).find((e) => e.type === 'photo').photo.name;
  const queued = pending(server).length > 0;
  const exit = await server.stop(signal);
  shot.catch(() => {}); // the server is gone: the shot never sees "idle"
  return { name, queued, exit };
}

async function newServer(name) {
  const server = await startServer(name);
  if (!REAL) server.camera.photo(await photos.p24());
  await server.settings({ frame: '04-elegant', frameTitle: 'Restart test' });
  return server;
}

test('power cut during processing: the photo stays listed, its processing resumes on start-up', async () => {
  let server = await newServer('crash');
  let r;
  // the full size of a 24 Mpx photo takes a few hundred ms: try again if it was faster than the kill
  for (let i = 0; i < 3; i++) {
    r = await shootThenStop(server, 'SIGKILL');
    if (r.queued && !fs.existsSync(path.join(server.photosDir, r.name))) break;
    server = await startServer('crash', { dirs: server.dirs });
  }
  assert.equal(r.exit.signal, 'SIGKILL');
  assert.ok(!fs.existsSync(path.join(server.photosDir, r.name)), 'full size not written before the cut');
  assert.deepEqual(pending(server), [`pending_${r.name}.json`]);
  const again = await startServer('crash', { dirs: server.dirs });
  try {
    await waitFullSize(again, r.name);
    assert.ok(again.logs.some((l) => l.includes(`${r.name}: full size resumed`)));
    assert.ok((await again.json('/api/photos')).some((p) => p.name === r.name));
    assert.deepEqual(fs.readdirSync(again.photosDir).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    await again.stop();
  }
});

test('clean stop (docker stop) waits for the photos being processed', async () => {
  const server = await newServer('stop');
  const r = await shootThenStop(server, 'SIGTERM');
  assert.equal(r.exit.code, 0);
  assert.ok(fs.existsSync(path.join(server.photosDir, r.name)), 'full size written before exiting');
  assert.deepEqual(pending(server), []);
  assert.ok(server.logs.some((l) => l.includes('[server] exiting.')));
});
