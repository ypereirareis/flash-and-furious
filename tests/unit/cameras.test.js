'use strict';

// The gphoto2 drivers, against the fake camera of the functional tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-'));
process.env.FAKE_CAMERA_DIR = state;
process.env.GPHOTO_BIN = path.join(__dirname, '../fake-camera/gphoto2');
const { Gphoto2Camera } = require('../../src/server/cameras/gphoto2');
const canon = require('../../src/server/cameras/canon-eos-1000d');

const mode = (m) => fs.writeFileSync(path.join(state, 'mode'), m);
test.beforeEach(() => mode('ok'));
test.after(() => fs.rmSync(state, { recursive: true, force: true }));

test('explainError: gphoto2 messages to user-facing text names', () => {
  const cam = new Gphoto2Camera({ id: 'x', label: 'X' });
  assert.equal(cam.explainError("*** Error (-53: 'Could not claim the USB device') ***"), 'claimed');
  assert.equal(cam.explainError('Could not lock the device'), 'claimed');
  assert.equal(cam.explainError('*** Error: No camera found. ***'), 'notDetected');
  assert.equal(cam.explainError('Error (-105: Unknown model)'), 'notDetected');
  assert.equal(cam.explainError('Out of Focus'), 'focusOrBusy');
  assert.equal(cam.explainError('Error (-110: I/O in progress)'), 'focusOrBusy');
  assert.equal(cam.explainError('Command failed: ETIMEDOUT'), 'timeout');
  assert.equal(cam.explainError('something else'), 'generic');
});

test('detect: cameras listed by gphoto2 --auto-detect', async () => {
  assert.deepEqual(await canon.detect(), [{ model: 'Canon EOS 1000D', port: 'usb:001,004' }]);
  mode('absent');
  assert.deepEqual(await canon.detect(), []);
});

test('detect: several cameras, odd lines', async () => {
  const cam = new Gphoto2Camera({ id: 'x', label: 'X' });
  cam.run = async () => 'Model   Port\n------\nNikon DSC D90 (PTP mode)       usb:002,003\n\nSome Camera\n';
  assert.deepEqual(await cam.detect(), [
    { model: 'Nikon DSC D90 (PTP mode)', port: 'usb:002,003' },
    { model: 'Some Camera', port: '' },
  ]);
});

test('errors carry the name of their user-facing text', async () => {
  mode('claimed');
  await assert.rejects(canon.probe(), (err) => err.textKey === 'claimed');
  mode('unresponsive');
  await assert.rejects(canon.probe(), (err) => err.textKey === 'generic');
});

test('Canon 1000D: focus mode read from the camera', async () => {
  assert.deepEqual(await canon.probe(), { focusMode: 'auto', raw: 'One Shot' });
  fs.writeFileSync(path.join(state, 'focus'), 'Manual');
  assert.deepEqual(await canon.getFocusMode(), { raw: 'Manual', mode: 'manual' });
  fs.writeFileSync(path.join(state, 'focus'), 'AI Servo');
  assert.equal((await canon.getFocusMode()).mode, 'auto');
  fs.rmSync(path.join(state, 'focus'));
});

test('Canon 1000D: no remote autofocus, retries a capture in AF only', async () => {
  assert.deepEqual(await canon.autofocus(), { ok: false, skipped: true });
  assert.equal(canon.shouldRetryWithoutFile({ manual: false }), true);
  assert.equal(canon.shouldRetryWithoutFile({ manual: true }), false);
});

test('capture: the photo is copied as <name>.jpg (and .cr2 in RAW+JPEG)', async () => {
  const src = path.join(state, 'src.jpg');
  fs.writeFileSync(src, 'jpeg bytes');
  fs.writeFileSync(path.join(state, 'photo'), src);
  fs.writeFileSync(path.join(state, 'raw'), '');
  await canon.capture(state, 'shot');
  assert.equal(fs.readFileSync(path.join(state, 'shot.jpg'), 'utf8'), 'jpeg bytes');
  assert.ok(fs.existsSync(path.join(state, 'shot.cr2')));
  fs.rmSync(path.join(state, 'raw'));
});

test('exclusive: one camera command at a time, in order, even after a failure', async () => {
  const cam = new Gphoto2Camera({ id: 'x', label: 'X' });
  const log = [];
  const step = (name, ms, fail) => () => new Promise((resolve, reject) => {
    log.push(`start ${name}`);
    setTimeout(() => { log.push(`end ${name}`); fail ? reject(new Error(name)) : resolve(name); }, ms);
  });
  const results = await Promise.allSettled([
    cam.exclusive(step('a', 30)),
    cam.exclusive(step('b', 5, true)),
    cam.exclusive(step('c', 1)),
  ]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});
