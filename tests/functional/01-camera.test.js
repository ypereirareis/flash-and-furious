'use strict';

// Camera detection and connection problems, as shown on the tablet and in /admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const { REAL, fakeOnly, startServer, waitFor } = require('./helpers');

let server;
test.before(async () => { server = await startServer('camera'); });
test.after(() => server.stop());

/** Status once its error matches (the camera is polled every 4 s, probed on request). */
const statusUntil = (pred, what) => waitFor(async () => { const s = await server.status(true); return pred(s) && s; }, { timeout: 25000, interval: 500, what });

test('camera detected, focus mode read', async () => {
  // the camera is listed as soon as it is seen on USB, its focus mode a moment later
  const s = await waitFor(async () => { const x = await server.status(); return x.focusMode && x; }, { what: 'the focus mode' });
  assert.equal(s.camera.model, 'Canon EOS 1000D');
  assert.match(s.camera.port, /^usb:/);
  assert.equal(s.error, null);
  assert.ok(['auto', 'manual'].includes(s.focusMode));
  if (!REAL) assert.equal(s.focusMode, 'auto');
});

test('camera driver and its help texts', async () => {
  const info = await server.json('/api/camera');
  assert.equal(info.driver, 'canon-eos-1000d');
  assert.equal(info.capabilities.focusMode, true);
  assert.ok(info.texts.focusModeHint.length > 10);
});

test('manual focus read on the camera', { skip: fakeOnly }, async () => {
  require('fs').writeFileSync(`${server.camera.dir}/focus`, 'Manual');
  await statusUntil((s) => s.focusMode === 'manual', 'manual focus');
  require('fs').rmSync(`${server.camera.dir}/focus`);
  await statusUntil((s) => s.focusMode === 'auto', 'auto focus');
});

test('camera unplugged or switched off: reported, photos refused, back when plugged in', { skip: fakeOnly }, async () => {
  server.camera.mode('absent');
  const s = await statusUntil((x) => x.camera === null, 'the camera to disappear');
  assert.match(s.error, /No camera detected/);
  const res = await server.api('/api/shoot', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /No camera detected/);
  server.camera.mode('ok');
  await statusUntil((x) => x.camera && !x.error, 'the camera to come back');
});

test('camera claimed by another program (desktop automount): dedicated message', { skip: fakeOnly }, async () => {
  server.camera.mode('claimed');
  const s = await statusUntil((x) => x.error && /another program/.test(x.error), 'the claimed message');
  assert.ok(s.camera, 'still seen on USB');
  assert.equal((await server.api('/api/shoot', { method: 'POST' })).status, 503);
  server.camera.mode('ok');
  await statusUntil((x) => x.camera && !x.error, 'the camera to be free');
});

test('camera not responding (asleep): reported until it answers again', { skip: fakeOnly }, async () => {
  server.camera.mode('unresponsive');
  await statusUntil((x) => x.error && /not responding/.test(x.error), 'the not-responding message');
  server.camera.mode('ok');
  await statusUntil((x) => x.camera && !x.error, 'the camera to answer');
});
