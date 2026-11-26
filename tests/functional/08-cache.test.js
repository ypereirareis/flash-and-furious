'use strict';

// Photo deleted on the host: its copies in the cache are removed at the next start-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, shoot, waitFullSize, media } = require('./helpers');

const copies = (server, name) => fs.readdirSync(server.cacheDir).filter((f) => f.endsWith(`_${name}`)).sort();

test('copies of a photo deleted on the host: removed at start-up, the other photos keep theirs', async () => {
  let server = await startServer('cache');
  const kept = (await shoot(server)).photo;
  const deleted = (await shoot(server)).photo;
  for (const p of [kept, deleted]) {
    await waitFullSize(server, p.name);
    for (const kind of ['thumb', 'view', 'tv']) assert.equal((await media(server, p[kind])).status, 200);
  }
  assert.deepEqual(copies(server, deleted.name), [`thumb_${deleted.name}`, `tv_${deleted.name}`, `view_${deleted.name}`]);
  await server.stop();

  // deleted on the host while the app is stopped, plus a leftover of an interrupted write
  fs.rmSync(path.join(server.photosDir, deleted.name));
  fs.writeFileSync(path.join(server.cacheDir, `thumb_${kept.name}.tmp`), 'cut');

  server = await startServer('cache', { dirs: server.dirs });
  try {
    assert.deepEqual(copies(server, deleted.name), []);
    assert.equal(copies(server, kept.name).length, 3);
    assert.ok(!fs.existsSync(path.join(server.cacheDir, `thumb_${kept.name}.tmp`)));
    assert.ok(server.logs.some((l) => /\[cache\] 4 file\(s\)/.test(l)), 'cleaning logged');
    assert.deepEqual((await server.json('/api/photos')).map((p) => p.name), [kept.name]);
  } finally {
    await server.stop();
  }
});
