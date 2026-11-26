'use strict';

// Feature modules (features/ folder) chosen with FEATURES: none of them, the app still works.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeOnly, startServer, shoot } = require('./helpers');

test('FEATURES=none: no module on the screens, in the settings or on the photos', { skip: fakeOnly }, async () => {
  const server = await startServer('no-features', { env: { FEATURES: 'none' } });
  try {
    assert.deepEqual(await server.json('/api/features'), []);
    for (const url of ['/api/frames', '/api/backgrounds', '/features/bw/booth.js']) assert.equal((await server.api(url)).status, 404, url);
    // the settings of the modules are neither sent nor changed
    const s = await server.settings({ photoDeco: true, frame: '02-party', greenScreen: true });
    assert.deepEqual(Object.keys(s).sort(), ['lang', 'live', 'mirror', 'theme']);
    for (const url of ['/', '/admin', '/slideshow', '/features.js']) assert.equal((await server.api(url)).status, 200, url);
    // asked for by an old tablet page: ignored
    const shot = await shoot(server, { bw: true });
    assert.deepEqual(shot.errors, []);
    assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'framing'), 'no processing');
    const [last] = (await server.json('/api/journal?limit=1')).entries;
    assert.equal(last.message, 'Photo taken');
  } finally {
    await server.stop();
  }
});

test('unknown module in FEATURES: ignored, the others active', { skip: fakeOnly }, async () => {
  const server = await startServer('some-features', { env: { FEATURES: 'bw, nope' } });
  try {
    assert.deepEqual((await server.json('/api/features')).map((f) => f.id), ['bw']);
    assert.ok(!('photoDeco' in (await server.json('/api/settings'))));
  } finally {
    await server.stop();
  }
});
