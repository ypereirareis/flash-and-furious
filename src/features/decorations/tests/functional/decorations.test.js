'use strict';

// Theme decorations module: on the tablet (CSS of each theme), on a photo without frame (in
// colour over black & white), their two settings in /admin, and nowhere when switched off.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, shoot, waitFullSize, colourAt, isGrey } = require('../../../../../tests/functional/helpers');

let server;
test.before(async () => { server = await startServer('decorations'); });
test.after(() => server.stop());

test('theme decorations on a photo without frame, in colour over black & white', async () => {
  await server.settings({ theme: 'birthday', photoDeco: true });
  const shot = await shoot(server, { bw: true, label: 'decorations, B&W' });
  assert.deepEqual(shot.errors, []);
  await waitFullSize(server, shot.photo.name);
  const final = path.join(server.photosDir, shot.photo.name);
  const corner = [];
  for (let x = 0.02; x < 0.25; x += 0.02) corner.push(await colourAt(final, x, 0.9));
  assert.ok(corner.some((c) => !isGrey(c)), 'drawing in colour in the bottom-left corner');
  assert.ok(isGrey(await colourAt(final, 0.6, 0.5)), 'photo in grey');
  const [last] = (await server.json('/api/journal?limit=1')).entries;
  assert.equal(last.message, 'Photo taken: theme decorations, black & white');
});

test('theme without decorations: nothing to add', async () => {
  await server.settings({ theme: 'night', photoDeco: true });
  const shot = await shoot(server);
  assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
});

test('on the tablet: loaded by the screens, drawings of the themes that have some', async () => {
  const mod = (await server.json('/api/features')).find((f) => f.id === 'decorations');
  assert.deepEqual(mod.css, ['/features/decorations/decorations.css', '/api/decorations/themes.css']);
  assert.deepEqual(mod.booth, ['/features/decorations/booth.js']);
  const css = await (await server.api('/api/decorations/themes.css')).text();
  assert.match(css, /html\[data-theme="halloween"\] \{[^}]*--deco-corner: url\("\/features\/decorations\/deco\/halloween-corner\.svg"\)/);
  assert.ok(!css.includes('"night"'), 'theme without decorations');
  for (const url of mod.css.concat(['/features/decorations/deco/halloween-corner.svg'])) assert.equal((await server.api(url)).status, 200, url);
});

test('settings: tablet on and photos off by default, one journal entry per change', async () => {
  await server.settings({ photoDeco: false });
  let s = await server.json('/api/settings');
  assert.equal(s.screenDeco, true);
  assert.deepEqual(s.decoThemes.sort(), ['birthday', 'christmas', 'halloween', 'wedding']);
  s = await server.settings({ screenDeco: false, photoDeco: true });
  assert.deepEqual([s.screenDeco, s.photoDeco], [false, true]);
  const recent = (await server.json('/api/journal?limit=2')).entries.map((e) => e.message).sort();
  assert.deepEqual(recent, ['Theme decorations on photos: on', 'Theme decorations on the tablet: off']);
  await server.settings({ screenDeco: true, photoDeco: false });
});

test('switched off (not in FEATURES): no decorations anywhere, no settings', async () => {
  const off = await startServer('decorations-off', { env: { FEATURES: 'bw' } });
  try {
    for (const url of ['/api/decorations/themes.css', '/features/decorations/decorations.css', '/features/decorations/deco/halloween-corner.svg']) {
      assert.equal((await off.api(url)).status, 404, url);
    }
    assert.ok(!(await off.json('/api/features')).some((f) => f.id === 'decorations'));
    assert.ok(!(await off.api('/themes.css').then((r) => r.text())).includes('deco'), 'nothing in the themes');
    const s = await off.settings({ theme: 'halloween', photoDeco: true, screenDeco: true });
    for (const k of ['photoDeco', 'screenDeco', 'decoThemes']) assert.ok(!(k in s), `no ${k}`);
    const shot = await shoot(off);
    assert.ok(!shot.events.some((e) => e.type === 'phase' && e.phase === 'editing'), 'no processing');
  } finally {
    await off.stop();
  }
});
