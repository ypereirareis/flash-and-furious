'use strict';

// Event journal of /admin: what is written, in which language, pages, restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakeOnly, startServer, shoot, waitFor } = require('./helpers');

let server;
test.before(async () => {
  server = await startServer('journal', { env: { JOURNAL_MAX_PER_MINUTE: '1000' } });
});
test.after(() => server.stop());

const all = async (s = server) => {
  const out = [];
  let before = '';
  for (;;) {
    const page = await s.json(`/api/journal?limit=200${before}`);
    out.push(...page.entries);
    if (!page.more) return out;
    before = `&before=${page.entries.at(-1).id}`;
  }
};
const messages = async (s) => (await all(s)).map((e) => e.message);

test('start-up written: booth started, camera ready', async () => {
  const list = await all();
  assert.equal(list.at(-1).message, 'Photobooth started');
  assert.equal(list.at(-1).category, 'system');
  const camera = await waitFor(async () => (await all()).find((e) => e.category === 'camera' && e.level === 'success'), { what: 'camera entry' });
  assert.equal(camera.message, 'Camera ready: Canon EOS 1000D');
});

test('photo written with its frame and file name, sent live to /admin', async () => {
  await server.settings({ frame: '01-polaroid' });
  const from = server.events.list.length;
  const shot = await shoot(server, { bw: true });
  const [last] = (await server.json('/api/journal?limit=1')).entries;
  assert.equal(last.message, 'Photo taken in black & white with the “Polaroid” frame');
  assert.equal(last.detail, shot.photo.name);
  assert.equal(last.level, 'success');
  const live = server.events.list.slice(from).filter((e) => e.type === 'journal').map((e) => e.entry.message);
  assert.ok(live.includes(last.message), 'live event');
});

test('settings changes: one entry each', async () => {
  await server.settings({ frame: '02-party', theme: 'birthday', frameTitle: 'Coucou Marjo', live: true, mirror: false, frameDeco: true });
  await server.settings({ frame: null, live: false, mirror: true, frameDeco: false });
  const recent = (await messages()).slice(0, 10);
  for (const m of ['Frame: Party', 'Theme: Birthday', 'Frame text: “Coucou Marjo”', 'Live view during the countdown: on',
    'Mirror effect: off', 'Theme decorations on photos: on', 'Frame: none', 'Live view during the countdown: off',
    'Mirror effect: on', 'Theme decorations on photos: off']) {
    assert.ok(recent.includes(m), m);
  }
});

test('camera unplugged: written once, not every 4 s; back: written once', { skip: fakeOnly }, async () => {
  const count = async (re) => (await messages()).filter((m) => re.test(m)).length;
  const lost = await count(/No camera detected/);
  const ready = await count(/Camera ready/);
  server.camera.mode('absent');
  await waitFor(async () => (await count(/No camera detected/)) > lost, { timeout: 15000, what: 'unplugged entry' });
  await new Promise((r) => setTimeout(r, 9000)); // two more polls
  assert.equal(await count(/No camera detected/), lost + 1);
  server.camera.mode('ok');
  await waitFor(async () => (await count(/Camera ready/)) > ready, { timeout: 15000, what: 'camera back' });
  const [last] = (await server.json('/api/journal?limit=1')).entries;
  assert.equal(last.level, 'success');
});

test('focus failure written as an error', { skip: fakeOnly }, async () => {
  server.camera.mode('nofocus');
  await shoot(server);
  server.camera.mode('ok');
  const failed = (await all()).find((e) => e.message.startsWith('No photo:'));
  assert.equal(failed.level, 'error');
  assert.match(failed.message, /could not focus/);
});

test('pages: newest first, no gap nor duplicate', async () => {
  for (let i = 0; i < 60; i++) await server.settings({ mirror: i % 2 === 0 });
  const ids = [];
  let before = '';
  for (let p = 0; p < 50; p++) {
    const page = await server.json(`/api/journal?limit=7${before}`);
    ids.push(...page.entries.map((e) => e.id));
    if (!page.more) break;
    before = `&before=${page.entries.at(-1).id}`;
  }
  assert.ok(ids.length > 60);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate');
  assert.equal(ids[0] - ids.at(-1) + 1, ids.length, 'no gap');
});

test('translated in the language chosen in /admin', async () => {
  await server.settings({ lang: 'fr' });
  const list = await all();
  assert.equal(list.at(-1).message, 'Photobooth démarré');
  assert.ok(list.some((e) => e.message === 'Langue : Français'));
  await server.settings({ lang: 'en' });
  assert.equal((await all()).at(-1).message, 'Photobooth started');
});

test('kept across a restart; the clean stop is written', async () => {
  const before = await all();
  const exit = await server.stop('SIGTERM');
  assert.equal(exit.code, 0);
  const file = path.join(server.configDir, 'journal.jsonl');
  assert.ok(fs.statSync(file).size > 0);
  server = await startServer('journal', { dirs: server.dirs });
  const after = await all();
  assert.ok(after.some((e) => e.message === 'Photobooth started' && e.id > before[0].id), 'new start written');
  // "stopped", or "stopping: waiting for N photo(s)" when a full size was still being computed
  assert.ok(after.some((e) => /^Photobooth stop/.test(e.message) && e.id > before[0].id), 'stop written');
  const stop = after.findIndex((e) => /^Photobooth stop/.test(e.message));
  const start = after.findIndex((e) => e.message === 'Photobooth started');
  assert.ok(start < stop, 'nothing written between the stop and the next start');
  assert.equal(stop - start, 1);
  for (const e of before) assert.ok(after.some((x) => x.id === e.id), `entry ${e.id} kept`);
});
