'use strict';

// Small limits, so that they are reached quickly
process.env.JOURNAL_MAX_ENTRIES = '100';
process.env.JOURNAL_MAX_BYTES = String(20 * 1024);
process.env.JOURNAL_MAX_PER_MINUTE = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../../server/journal');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = path.join(tmp, `j${n++}`);
  fs.mkdirSync(dir);
  journal.load(dir);
  return dir;
};
const file = (dir) => path.join(dir, 'journal.jsonl');

test('entries: newest first, pages with before/limit', async () => {
  const dir = fresh();
  for (let i = 1; i <= 7; i++) journal.add('info', 'photo', 'journal.photo', {}, `p${i}.jpg`);
  const p1 = journal.page({ limit: 3 });
  assert.deepEqual(p1.entries.map((e) => e.detail), ['p7.jpg', 'p6.jpg', 'p5.jpg']);
  assert.equal(p1.more, true);
  const p2 = journal.page({ before: p1.entries.at(-1).id, limit: 3 });
  assert.deepEqual(p2.entries.map((e) => e.detail), ['p4.jpg', 'p3.jpg', 'p2.jpg']);
  const p3 = journal.page({ before: p2.entries.at(-1).id, limit: 3 });
  assert.deepEqual(p3.entries.map((e) => e.detail), ['p1.jpg']);
  assert.equal(p3.more, false);
  assert.equal(journal.page({ limit: 'x' }).entries.length, 7, 'bad limit: default');
  await journal.close();
  assert.equal(fs.readFileSync(file(dir), 'utf8').trim().split('\n').length, 7);
});

test('saved and read again after a restart, ids go on', async () => {
  const dir = fresh();
  journal.add('success', 'camera', 'journal.cameraConnected', { model: 'Canon' });
  journal.add('nope', 'nope', 'journal.started'); // unknown level / category: defaults
  await journal.close();
  assert.equal(journal.load(dir), 2);
  const [last, first] = journal.page().entries;
  assert.deepEqual([first.level, first.category, first.vars], ['success', 'camera', { model: 'Canon' }]);
  assert.deepEqual([last.level, last.category], ['info', 'system']);
  assert.equal(journal.add('info', 'system', 'journal.started').id, last.id + 1);
});

test('damaged and duplicated lines are skipped', () => {
  const dir = path.join(tmp, 'damaged');
  fs.mkdirSync(dir);
  const e = (id) => JSON.stringify({ id, at: id, level: 'info', category: 'system', key: 'journal.started', vars: {} });
  fs.writeFileSync(file(dir), `${e(1)}\n{"id": 2, "key": "cut in the mid\n${e(3)}\n${e(3)}\nnot json\n`);
  assert.equal(journal.load(dir), 2);
  assert.deepEqual(journal.page().entries.map((x) => x.id), [3, 1]);
});

test('texts are cut, messages given as values are kept', () => {
  fresh();
  const e = journal.add('error', 'photo', 'journal.shootFailed', { reason: { camera: 'focusFailed' }, text: 'x'.repeat(1000) }, 'y'.repeat(1000));
  assert.equal(e.vars.text.length, journal.MAX_TEXT);
  assert.equal(e.detail.length, journal.MAX_TEXT);
  assert.deepEqual(e.vars.reason, { camera: 'focusFailed' });
});

test('never more than the limits in memory and on disk', async () => {
  const dir = fresh();
  for (let i = 0; i < 3000; i++) {
    journal.add('info', 'photo', 'journal.photoFrame', { frame: 'f'.repeat(150) }, `photo-${i}.jpg`);
    if (i % 100 === 0) await journal.close(); // like the 1 s batches
  }
  await journal.close();
  const size = fs.statSync(file(dir)).size;
  assert.ok(size <= journal.MAX_BYTES * 1.1, `file ${size} bytes`);
  assert.ok(journal.page({ limit: 200 }).entries.length <= journal.MAX_ENTRIES * 1.1);
  assert.equal(journal.page().entries[0].detail, 'photo-2999.jpg', 'newest kept');
  assert.ok(journal.load(dir) <= journal.MAX_ENTRIES);
  assert.ok(!fs.existsSync(`${file(dir)}.tmp`));
});

test('oversized file at start-up: only its end is read, then it is cut', () => {
  const dir = path.join(tmp, 'huge');
  fs.mkdirSync(dir);
  const line = (id) => `${JSON.stringify({ id, at: id, level: 'info', category: 'system', key: 'journal.started', vars: { pad: 'z'.repeat(150) } })}\n`;
  const fd = fs.openSync(file(dir), 'w');
  for (let id = 1; id <= 30000; id++) fs.writeSync(fd, line(id)); // ~6 MB
  fs.closeSync(fd);
  const count = journal.load(dir);
  assert.ok(count > 0 && count <= journal.MAX_ENTRIES);
  assert.equal(journal.page().entries[0].id, 30000);
  assert.ok(fs.statSync(file(dir)).size <= journal.MAX_BYTES);
});

test('disk refusing to write: no error for the caller, the journal goes on in memory', { skip: process.getuid() === 0 && 'root can write anywhere' }, async () => {
  const dir = fresh();
  fs.chmodSync(dir, 0o555);
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.ok(journal.add('info', 'system', 'journal.started'));
    await journal.close();
    assert.ok(journal.add('info', 'system', 'journal.stopping'));
    await journal.close();
  } finally {
    console.error = orig;
    fs.chmodSync(dir, 0o755);
  }
  assert.equal(journal.page().entries.length, 2);
  assert.equal(errors.length, 1, 'one message, then paused');
});

test('adding is immediate: 10,000 entries in well under a second', () => {
  fresh();
  const t = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) journal.add('info', 'photo', 'journal.photo', {}, `p${i}.jpg`);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 500, `${ms} ms`);
});

test('a failing listener does not break the journal', () => {
  fresh();
  const off = journal.onAdd(() => { throw new Error('boom'); });
  const seen = [];
  const off2 = journal.onAdd((e) => seen.push(e.key));
  assert.ok(journal.add('info', 'system', 'journal.started'));
  assert.deepEqual(seen, ['journal.started']);
  off();
  off2();
});

test('flushSync writes what is waiting at once (process exit)', () => {
  const dir = fresh();
  journal.add('info', 'system', 'journal.stopping');
  journal.flushSync();
  assert.match(fs.readFileSync(file(dir), 'utf8'), /journal\.stopping/);
});
