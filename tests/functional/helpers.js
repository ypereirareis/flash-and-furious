'use strict';

/**
 * Functional test helpers: each test file starts the real server (node server/index.js) as a
 * child process, with its own photos and config folders, and drives it through its HTTP API
 * and its events, like the tablet does.
 *
 * Environment (set by scripts/test.sh):
 *   CAMERA         fake (default): fake gphoto2 of tests/fake-camera; real: the camera on USB
 *   TEST_WORK_DIR  folder for the test photos, server logs and timings (kept with --keep)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const CAMERA = process.env.CAMERA === 'real' ? 'real' : 'fake';
const REAL = CAMERA === 'real';
const WORK = process.env.TEST_WORK_DIR || fs.mkdtempSync('/tmp/functional-');
const FAKE_GPHOTO = path.join(ROOT, 'tests', 'fake-camera', 'gphoto2');
fs.mkdirSync(path.join(WORK, 'logs'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 4100 + Math.floor(Math.random() * 500) * 2;

/** Skips a test that needs the fake camera (failure modes, special photos) in real mode. */
const fakeOnly = REAL ? 'needs the fake camera' : false;

/** Waits until fn() returns a truthy value. */
async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (_) {
      /* not yet */
    }
    await sleep(interval);
  }
  throw new Error(`timeout (${timeout} ms) waiting for ${what}`);
}

/* ------------------------------------------------------------------ */
/* Test photos                                                         */
/* ------------------------------------------------------------------ */
const FIXTURES = path.join(WORK, 'fixtures');

/**
 * Test photo: left half red, right half blue, a green disc in the middle, light noise.
 * Colours are checked after processing (colour kept, or black & white).
 */
async function fixture(name, width, height, { orientation } = {}) {
  const file = path.join(FIXTURES, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(FIXTURES, { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="50%" height="100%" fill="#d02828"/><rect x="50%" width="50%" height="100%" fill="#2838d0"/>
    <circle cx="50%" cy="50%" r="${Math.round(height / 6)}" fill="#28c048"/></svg>`;
  const noise = await sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 12 } } })
    .png()
    .toBuffer();
  let img = sharp(await sharp(Buffer.from(svg)).composite([{ input: noise, blend: 'soft-light' }]).png().toBuffer());
  if (orientation) img = img.withMetadata({ orientation });
  await img.jpeg({ quality: 92 }).toFile(`${file}.tmp`);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}
const photos = {
  p10: () => fixture('10mp.jpg', 3888, 2592), // Canon EOS 1000D
  p24: () => fixture('24mp.jpg', 6000, 4000),
  rotated: () => fixture('rotated.jpg', 3888, 2592, { orientation: 6 }), // camera held upright
  live: () => fixture('live.jpg', 848, 560),
};

/* ------------------------------------------------------------------ */
/* Fake camera                                                         */
/* ------------------------------------------------------------------ */
function fakeCamera(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), v);
  return {
    dir,
    mode: (m) => write('mode', m),
    photo: (file) => write('photo', file),
    raw: (on) => (on ? write('raw', '') : fs.rmSync(path.join(dir, 'raw'), { force: true })),
    /** gphoto2 calls made so far, e.g. calls('--capture-image') */
    calls: (prefix = '') => {
      try {
        return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l && l.startsWith(prefix));
      } catch (_) {
        return [];
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
/**
 * Starts the server. `dirs` reuses the folders of a previous server (restart after a stop).
 * Returns { url, photosDir, configDir, camera, events, logs, api, stop, kill, ... }.
 */
async function startServer(name, { env = {}, dirs = null, waitCamera = true } = {}) {
  const base = dirs ? dirs.base : fs.mkdtempSync(path.join(WORK, `${name}-`));
  const photosDir = path.join(base, 'photos');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(photosDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const camera = fakeCamera(path.join(base, 'fake-camera'));
  if (!REAL && !dirs) {
    camera.photo(await photos.p10());
    fs.copyFileSync(await photos.live(), path.join(camera.dir, 'live.jpg'));
  }
  const port = nextPort++;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      TZ: process.env.TZ || 'Europe/Paris',
      PORT: String(port),
      PHOTOS_DIR: photosDir,
      CONFIG_DIR: configDir,
      DEFAULT_LANG: 'en',
      DEFAULT_DELAY: '1',
      LOOK_MESSAGE_SECONDS: '0',
      PRE_MESSAGE_SECONDS: '0',
      FOCUS_BEFORE_END: '0',
      PUID: process.env.PUID || '',
      PGID: process.env.PGID || '',
      ...(REAL ? {} : { GPHOTO_BIN: FAKE_GPHOTO, FAKE_CAMERA_DIR: camera.dir }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(WORK, 'logs', `${path.basename(base)}.log`);
  const logs = [];
  const onLog = (d) => {
    logs.push(...String(d).split('\n').filter(Boolean));
    fs.appendFileSync(logFile, d);
  };
  proc.stdout.on('data', onLog);
  proc.stderr.on('data', onLog);
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));

  const url = `http://127.0.0.1:${port}`;
  const server = {
    name, url, port, proc, logs, exited, photosDir, configDir, camera,
    dirs: { base },
    cacheDir: path.join(photosDir, '.cache'),
    originalsDir: path.join(photosDir, 'originals'),
    api: (p, opts) => fetch(url + p, opts),
    json: async (p, opts) => (await fetch(url + p, opts)).json(),
    status: (probe = false) => server.json(`/api/status${probe ? '?probe=1' : ''}`),
    settings: (patch) => server.json('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
    /** Stops the server with a signal and waits for it to exit. */
    stop: async (signal = 'SIGTERM') => {
      server.events.close();
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return exited;
    },
  };
  await waitFor(() => server.api('/api/status').then((r) => r.ok), { what: `server ${name} to start` });
  server.events = await listen(url);
  if (waitCamera) await waitFor(async () => { const s = await server.status(); return s.camera && !s.error; }, { timeout: 20000, what: 'the camera' });
  return server;
}

/** Collects the server events (Server-Sent Events, like the tablet). */
async function listen(url) {
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) });
          }
        }
      }
    } catch (_) {
      /* closed */
    }
  })();
  await waitFor(() => events.some((e) => e.type === 'hello'), { what: 'the event stream' });
  return { list: events, close: () => ctrl.abort() };
}

/**
 * Takes a photo like the tablet does and waits for the end of the shot.
 * Returns { status, photo, errors, timings: { captureToTablet, processingWait } } (seconds).
 */
async function shoot(server, { bw = false, label = '' } = {}) {
  await waitFor(async () => !(await server.status()).busy, { timeout: 60000, what: 'the booth to be free' });
  const ev = server.events.list;
  const from = ev.length;
  const res = await server.api('/api/shoot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bw }) });
  if (res.status !== 202) return { status: res.status, body: await res.json() };
  const since = () => ev.slice(from);
  await waitFor(() => since().some((e) => e.type === 'phase' && e.phase === 'idle'), { timeout: 60000, what: 'the end of the shot' });
  const at = (pred) => (since().find(pred) || {}).at;
  const capturing = at((e) => e.phase === 'capturing');
  const framing = at((e) => e.phase === 'framing');
  const photoEvent = since().find((e) => e.type === 'photo');
  const timings = {
    captureToTablet: photoEvent && capturing ? (photoEvent.at - capturing) / 1000 : null,
    processingWait: photoEvent && framing ? (photoEvent.at - framing) / 1000 : null,
  };
  if (label && photoEvent) recordTiming(label, timings);
  return {
    status: 202,
    photo: photoEvent ? photoEvent.photo : null,
    errors: since().filter((e) => e.type === 'error').map((e) => e.message),
    events: since(),
    timings,
  };
}

/** Timings table printed at the end by tests/functional/report.js */
function recordTiming(label, t) {
  fs.appendFileSync(path.join(WORK, 'timings.jsonl'), `${JSON.stringify({ label, camera: CAMERA, ...t })}\n`);
}

/** Full-size photo written (queue done for this photo). */
function waitFullSize(server, name, timeout = 60000) {
  return waitFor(
    () => fs.existsSync(path.join(server.photosDir, name)) && !fs.existsSync(path.join(server.cacheDir, `pending_${name}.json`)),
    { timeout, what: `the full-size version of ${name}` }
  );
}

/** Image served by the server: { status, headers, meta } */
async function media(server, url) {
  const res = await server.api(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, meta: res.ok ? await sharp(buf).metadata() : null };
}

/** Size of an image once its EXIF orientation is applied. */
async function orientedSize(file) {
  const m = await sharp(file).metadata();
  return (m.orientation || 1) >= 5 ? [m.height, m.width] : [m.width, m.height];
}

/** Mean colour of a small square around (fx, fy), as fractions of the image size. */
async function colourAt(file, fx, fy) {
  const img = sharp(file).rotate();
  const { width, height } = await sharp(await img.toBuffer()).metadata();
  const size = Math.max(4, Math.round(width / 100));
  const left = Math.min(width - size, Math.round(width * fx));
  const top = Math.min(height - size, Math.round(height * fy));
  // stats() reads its input, not the result of the operations: extract to a buffer first
  const square = await sharp(file).rotate().extract({ left, top, width: size, height: size }).png().toBuffer();
  const { channels } = await sharp(square).stats();
  return channels.slice(0, 3).map((c) => Math.round(c.mean));
}
const isGrey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 4;

module.exports = {
  CAMERA, REAL, WORK, fakeOnly, sleep, waitFor, photos, startServer, shoot, waitFullSize, media,
  orientedSize, colourAt, isGrey, recordTiming,
};
