'use strict';

// What protects the photos and the host: storage checks, focus failures, request limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { fakeOnly, startServer, shoot, waitFor } = require('./helpers');

test('photos folder gone (disk unplugged): photos refused, back when it returns', async () => {
  const server = await startServer('storage');
  try {
    const moved = `${server.photosDir}.unplugged`;
    fs.renameSync(server.photosDir, moved);
    const s = await waitFor(async () => { const x = await server.status(); return x.error && x; }, { what: 'the storage error' });
    assert.match(s.error, /photos folder cannot be written/);
    const res = await server.api('/api/shoot', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /Photo storage/);
    fs.renameSync(moved, server.photosDir);
    await waitFor(async () => (await server.status()).error === null, { what: 'storage back' });
    const shot = await shoot(server);
    assert.ok(shot.photo, 'photo taken again');
  } finally {
    await server.stop();
  }
});

test('disk almost full: photos refused before the camera fires', async () => {
  const server = await startServer('full', { env: { STORAGE_MIN_FREE_MB: String(1024 * 1024 * 1024) }, waitCamera: false });
  try {
    const s = await server.status();
    assert.match(s.error, /disk is almost full/);
    const captures = server.camera.calls('--capture-image').length;
    assert.equal((await server.api('/api/shoot', { method: 'POST' })).status, 503);
    assert.equal(server.camera.calls('--capture-image').length, captures, 'camera not fired');
  } finally {
    await server.stop();
  }
});

test('focus not found: one retry, then a clear message and no photo', { skip: fakeOnly }, async () => {
  const server = await startServer('nofocus');
  try {
    server.camera.mode('nofocus');
    const shot = await shoot(server);
    assert.equal(shot.photo, null);
    assert.equal(shot.errors.length, 1);
    assert.match(shot.errors[0], /could not focus/);
    assert.equal(server.camera.calls('--capture-image').length, 2, 'one retry');
    assert.ok(shot.events.some((e) => e.phase === 'retrying'));
    assert.deepEqual(fs.readdirSync(server.photosDir).filter((f) => f.endsWith('.jpg')), []);
  } finally {
    await server.stop();
  }
});

test('request limit per device: 600 per minute, then HTTP 429 with a message', async () => {
  const server = await startServer('ratelimit', { waitCamera: false });
  try {
    const codes = [];
    for (let i = 0; i < 40; i++) {
      codes.push(...(await Promise.all(Array.from({ length: 16 }, () => server.api('/api/photos').then((r) => r.status)))));
    }
    // the start-up calls (status, events) count too
    const ok = codes.filter((c) => c === 200).length;
    assert.ok(ok >= 590 && ok < 600, `${ok} requests accepted`);
    assert.ok(codes.includes(429));
    const res = await server.api('/api/photos');
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /Too many requests/);
    assert.equal((await server.api('/')).status, 200, 'pages still served');
  } finally {
    await server.stop();
  }
});
