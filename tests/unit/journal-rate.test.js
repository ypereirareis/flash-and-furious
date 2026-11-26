'use strict';

// At most JOURNAL_MAX_PER_MINUTE entries a minute: a bug cannot flood the journal.
process.env.JOURNAL_MAX_PER_MINUTE = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../../src/server/journal');

test('beyond the limit, entries are counted and reported once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const fs = require('fs');
  const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'journal-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  journal.load(dir);
  const added = Array.from({ length: 8 }, () => journal.add('info', 'system', 'journal.started'));
  assert.equal(added.filter(Boolean).length, 5);
  assert.equal(added.filter((e) => e === null).length, 3);
  t.mock.timers.tick(61 * 1000);
  journal.add('info', 'system', 'journal.stopping');
  const [last, skipped] = journal.page().entries;
  assert.equal(last.key, 'journal.stopping');
  assert.deepEqual([skipped.key, skipped.level, skipped.vars], ['journal.skipped', 'warning', { count: 3 }]);
});
