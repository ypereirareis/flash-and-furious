'use strict';

// storage.js reads its options from the environment when loaded: every check runs in a new
// Node process with the wanted environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STORAGE = path.join(__dirname, '../../src/server/storage.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));
test.after(() => {
  fs.chmodSync(path.join(tmp, 'readonly'), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function check(photos, { env = {}, configDir = null, probe = false } = {}) {
  const code = `const s = require(${JSON.stringify(STORAGE)});
    process.stdout.write(JSON.stringify(s.check(${JSON.stringify(photos)}, ${JSON.stringify(configDir)}, { probe: ${probe} })))`;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, ...env } }).toString());
}

const ok = path.join(tmp, 'ok');
fs.mkdirSync(ok);
fs.mkdirSync(path.join(tmp, 'readonly'));
fs.chmodSync(path.join(tmp, 'readonly'), 0o555);
fs.writeFileSync(path.join(tmp, 'file'), '');

test('writable folder: no problem, the write test leaves nothing behind', () => {
  assert.equal(check(ok), null);
  assert.equal(check(ok, { probe: true }), null);
  assert.deepEqual(fs.readdirSync(ok), []);
});

test('missing folder or a file instead: notWritable', () => {
  assert.equal(check(path.join(tmp, 'missing')), 'notWritable');
  assert.equal(check(path.join(tmp, 'file')), 'notWritable');
});

test('read-only folder: notWritable', { skip: process.getuid() === 0 && 'root can write anywhere' }, () => {
  assert.equal(check(path.join(tmp, 'readonly')), 'notWritable');
});

test('not enough free space: full', () => {
  assert.equal(check(ok, { env: { STORAGE_MIN_FREE_MB: String(1024 * 1024 * 1024) } }), 'full');
});

test('external disk expected but photos on the same disk as the config: externalMissing', () => {
  const config = path.join(tmp, 'config');
  fs.mkdirSync(config, { recursive: true });
  assert.equal(check(ok, { env: { PHOTOS_EXTERNAL: 'true' }, configDir: config }), 'externalMissing');
  assert.equal(check(ok, { env: { PHOTOS_EXTERNAL: 'false' }, configDir: config }), null);
});
