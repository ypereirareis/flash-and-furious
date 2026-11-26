'use strict';

// Cleaning of the photos cache at start-up: copies of deleted photos and leftovers removed,
// everything else kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanCache } = require('../../src/server/cache');

const KINDS = ['thumb', 'view', 'tv'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function folders(name) {
  const photos = path.join(tmp, name);
  const cache = path.join(photos, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const put = (dir, files) => files.forEach((f) => fs.writeFileSync(path.join(dir, f), 'x'.repeat(10)));
  return { photos, cache, put, left: () => fs.readdirSync(cache).sort() };
}

test('copies of a deleted photo are removed, those of an existing photo kept', () => {
  const f = folders('deleted');
  f.put(f.photos, ['a.jpg']);
  f.put(f.cache, ['thumb_a.jpg', 'view_a.jpg', 'tv_a.jpg', 'thumb_gone.jpg', 'view_gone.jpg', 'tv_gone.jpg']);
  assert.deepEqual(cleanCache(f.cache, f.photos, KINDS), { removed: 3, bytes: 30 });
  assert.deepEqual(f.left(), ['thumb_a.jpg', 'tv_a.jpg', 'view_a.jpg']);
});

test('photo still being processed: its job and its tablet copy are kept', () => {
  const f = folders('processing');
  f.put(f.cache, ['pending_b.jpg.json', 'view_b.jpg']);
  assert.equal(cleanCache(f.cache, f.photos, KINDS).removed, 0);
  assert.deepEqual(f.left(), ['pending_b.jpg.json', 'view_b.jpg']);
});

test('leftovers of a cut removed: .tmp files and temporary capture folders', () => {
  const f = folders('leftovers');
  f.put(f.photos, ['c.jpg']);
  f.put(f.cache, ['view_c.jpg.tmp', 'thumb_c.jpg.tmp']);
  fs.mkdirSync(path.join(f.cache, 'calibration-1795690000000'));
  f.put(path.join(f.cache, 'calibration-1795690000000'), ['calibration.jpg']);
  assert.equal(cleanCache(f.cache, f.photos, KINDS).removed, 3);
  assert.deepEqual(f.left(), []);
});

test('unknown files are not touched', () => {
  const f = folders('unknown');
  f.put(f.cache, ['notes.txt', 'other_x.jpg', 'pending_orphan.jpg.json']);
  assert.equal(cleanCache(f.cache, f.photos, KINDS).removed, 0);
  assert.deepEqual(f.left(), ['notes.txt', 'other_x.jpg', 'pending_orphan.jpg.json']);
});

test('photo that cannot be checked (read error): its copies are kept', { skip: process.getuid() === 0 && 'root reads everything' }, () => {
  const f = folders('unreadable');
  f.put(f.photos, ['d.jpg']);
  f.put(f.cache, ['thumb_d.jpg']);
  // the cache stays readable, but the photos folder cannot be searched: stat fails with EACCES
  const inner = path.join(tmp, 'unreadable-inner');
  fs.mkdirSync(inner);
  try {
    fs.chmodSync(inner, 0o000);
    assert.equal(cleanCache(f.cache, inner, KINDS).removed, 0);
  } finally {
    fs.chmodSync(inner, 0o755);
  }
  assert.deepEqual(f.left(), ['thumb_d.jpg']);
});

test('no cache folder: nothing to do, no error', () => {
  assert.deepEqual(cleanCache(path.join(tmp, 'none', '.cache'), path.join(tmp, 'none'), KINDS), { removed: 0, bytes: 0 });
});
