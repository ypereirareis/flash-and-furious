'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const QRCode = require('qrcode');
const camera = require('./cameras'); // camera driver (CAMERA_DRIVER)
const live = require('./live');
const frames = require('./frames');
const settings = require('./settings');
const themes = require('./themes');
const i18n = require('./i18n');

const PORT = Number(process.env.PORT || 3000);
const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || path.join(__dirname, '..', 'photos'));
const CACHE_DIR = path.join(PHOTOS_DIR, '.cache');
const ORIGINALS_DIR = path.join(PHOTOS_DIR, 'originals');
const DEFAULT_DELAY = clampInt(process.env.DEFAULT_DELAY, 0, 30, 5);
// How many seconds before the end of the countdown focusing starts
const FOCUS_BEFORE_END = clampInt(process.env.FOCUS_BEFORE_END, 0, 10, 2);
// Message shown before the countdown, with a smaller reminder below it.
// Unset = translated default text; empty = nothing.
const PRE_MESSAGE = process.env.PRE_MESSAGE;
const LOOK_MESSAGE = process.env.LOOK_MESSAGE;
const PRE_MESSAGE_SECONDS = clampInt(process.env.PRE_MESSAGE_SECONDS, 0, 10, 3);
const PUID = process.env.PUID ? Number(process.env.PUID) : null;
const PGID = process.env.PGID ? Number(process.env.PGID) : null;
const IMAGE_RE = /\.(jpe?g)$/i;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
chownSafe(PHOTOS_DIR);
chownSafe(CACHE_DIR);
chownSafe(ORIGINALS_DIR);
settings.load();
chownSafe(settings.CONFIG_DIR);

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// The container runs as root (USB access): files are handed back to the host user.
function chownSafe(p) {
  if (PUID === null || PGID === null) return;
  try {
    fs.chownSync(p, PUID, PGID);
  } catch (_) {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Translations                                                        */
/* ------------------------------------------------------------------ */
const lang = () => settings.get().lang;
const tr = (key, vars) => i18n.t(lang(), key, vars);
const locale = () => tr('locale');

/** Camera text: driver-specific ("cameras.<id>.<name>") if it exists, otherwise generic ("camera.<name>"). */
function cameraText(name) {
  const specific = `cameras.${camera.id}.${name}`;
  return tr(i18n.has(lang(), specific) ? specific : `camera.${name}`);
}
const CAMERA_TEXTS = ['focusModeHint', 'toManualSteps', 'toAutoSteps', 'focusDone', 'autofocusUnsupported'];

/**
 * Messages are kept untranslated, as { camera: textName } or { key, vars }, and translated
 * when sent, so that a language change in /admin also applies to the current state.
 */
function translate(m) {
  if (!m) return null;
  return m.camera ? cameraText(m.camera) : tr(m.key, m.vars);
}

/* ------------------------------------------------------------------ */
/* Real-time events (Server-Sent Events)                               */
/* ------------------------------------------------------------------ */
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

live.on('state', ({ state: s, textKey }) => broadcast({ type: 'live', state: s, message: textKey ? cameraText(textKey) : undefined }));

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */
function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!IMAGE_RE.test(base) || base.startsWith('.')) return null;
  return base;
}

async function listPhotos() {
  const entries = await fsp.readdir(PHOTOS_DIR, { withFileTypes: true });
  const photos = [];
  for (const e of entries) {
    if (!e.isFile() || !IMAGE_RE.test(e.name) || e.name.startsWith('.')) continue;
    const st = await fsp.stat(path.join(PHOTOS_DIR, e.name));
    photos.push({ name: e.name, mtime: st.mtimeMs, size: st.size });
  }
  photos.sort((a, b) => b.mtime - a.mtime);
  return photos.map(toDto);
}

function toDto(p) {
  const v = Math.round(p.mtime);
  return {
    name: p.name,
    date: new Date(p.mtime).toISOString(),
    thumb: `/media/thumb/${encodeURIComponent(p.name)}?v=${v}`,
    view: `/media/view/${encodeURIComponent(p.name)}?v=${v}`,
  };
}

const SIZES = { thumb: 480, view: 1920 };
const pending = new Map();

/** Generates (and caches) a resized copy, correctly oriented (EXIF). */
async function resized(name, kind) {
  const src = path.join(PHOTOS_DIR, name);
  const dst = path.join(CACHE_DIR, `${kind}_${name}`);
  const [s, d] = await Promise.all([fsp.stat(src), fsp.stat(dst).catch(() => null)]);
  if (d && d.mtimeMs >= s.mtimeMs) return dst;

  const key = `${kind}/${name}`;
  if (!pending.has(key)) {
    const job = (async () => {
      const tmp = `${dst}.tmp`;
      await sharp(src)
        .rotate()
        .resize({ width: SIZES[kind], height: SIZES[kind], fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: kind === 'thumb' ? 72 : 85, mozjpeg: true })
        .toFile(tmp);
      await fsp.rename(tmp, dst);
      chownSafe(dst);
      return dst;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return pending.get(key);
}

/* ------------------------------------------------------------------ */
/* Frames and decorations                                              */
/* ------------------------------------------------------------------ */
// Theme decorations to add to framed photos (/admin option), or null
function currentDeco(conf = settings.get()) {
  return conf.frameDeco ? themes.decoFiles(conf.theme) : null;
}
// Everything that changes how a frame looks: title, date language, decorations
function frameOptions(conf = settings.get()) {
  return { title: conf.frameTitle, locale: i18n.t(conf.lang, 'locale'), deco: currentDeco(conf) };
}
// Frame preview URL; changes with the file and the frame options (browser cache busting)
function framePreviewUrl(f) {
  const o = frameOptions();
  const t = crypto.createHash('md5').update(`${o.title}|${o.locale}|${o.deco ? o.deco.id : ''}`).digest('hex').slice(0, 8);
  return `/api/frames/${encodeURIComponent(f.id)}.png?v=${Math.round(f.mtime)}-${t}`;
}
// Frame name in the UI language (falls back to the SVG <title> or the file name)
function frameLabel(f) {
  const key = `frames.${f.id}`;
  return i18n.has(lang(), key) ? tr(key) : f.label;
}

/* ------------------------------------------------------------------ */
/* Shooting                                                            */
/* ------------------------------------------------------------------ */
const state = { busy: false, phase: 'idle', camera: null, cameraError: null, focusMode: null };

function setPhase(phase, extra = {}) {
  state.phase = phase;
  broadcast({ type: 'phase', phase, ...extra });
}

function timestamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
}

const fail = (message, reason) => Object.assign(new Error(reason), { userMessage: message });

async function runShoot(delay, useLive, frame, { bw = false } = {}) {
  state.busy = true;
  const baseName = `flash-and-furious_${timestamp()}`;
  let focusJob = null;
  // the focus mode may have changed: read it again right before
  await refreshFocusMode();
  const manual = state.focusMode === 'manual';
  const startFocus = () => {
    if (focusJob) return;
    if (manual) {
      // manual focus: no autofocus, only stop live view
      focusJob = live.stop().then(() => ({ ok: true, skipped: 'manual' }));
      return;
    }
    setPhase('focusing');
    // live view is stopped before focusing and taking the photo
    focusJob = live.stop().then(() => camera.autofocus());
  };

  try {
    // Countdown; focusing starts a few seconds before the end, once people are in place.
    if (useLive) {
      // Live view during the countdown: wait for the first frame so that people
      // can see themselves during the whole countdown.
      setPhase('preparing');
      live.start();
      await live.waitFirstFrame(5000);
    }
    const message = PRE_MESSAGE ?? tr('shoot.preMessage');
    const hint = LOOK_MESSAGE ?? tr('shoot.lookMessage');
    if ((message || hint) && PRE_MESSAGE_SECONDS > 0) {
      setPhase('warning', { message, hint });
      await sleep(PRE_MESSAGE_SECONDS * 1000);
    }
    for (let s = delay; s > 0; s--) {
      broadcast({ type: 'countdown', remaining: s, total: delay });
      if (s <= FOCUS_BEFORE_END) startFocus();
      await sleep(1000);
    }
    startFocus();
    const focus = await focusJob;

    setPhase('capturing', { focus });
    const before = Date.now();
    const listShot = async () => (await fsp.readdir(PHOTOS_DIR)).filter((f) => f.startsWith(baseName));
    const short = (o) => String(o || '').trim().replace(/\s+/g, ' ') || '(nothing)';
    let out = await camera.capture(PHOTOS_DIR, baseName);
    let files = await listShot();
    if (!files.length) {
      // Some cameras refuse to fire without focus: the driver decides whether to retry
      if (!camera.shouldRetryWithoutFile({ manual })) {
        console.warn(`[shoot] no photo received. Camera: ${short(out)}`);
        throw fail({ camera: 'noFile' }, 'no file');
      }
      console.warn(`[shoot] no photo received, retrying. Camera: ${short(out)}`);
      setPhase('retrying');
      await camera.autofocus();
      setPhase('capturing');
      out = await camera.capture(PHOTOS_DIR, baseName);
      files = await listShot();
      if (!files.length) {
        console.warn(`[shoot] still no photo. Camera: ${short(out)}`);
        throw fail({ camera: 'focusFailed' }, 'no file');
      }
    }

    files.forEach((f) => chownSafe(path.join(PHOTOS_DIR, f)));
    const jpeg = files.find((f) => IMAGE_RE.test(f));
    console.log(`[shoot] ${files.join(', ') || 'no file'} in ${Date.now() - before} ms`);

    if (!jpeg) throw fail({ key: files.length ? 'shoot.noJpeg' : 'shoot.noFiles' }, 'no jpeg');
    if (frame || bw) await processPhoto(frame, files, jpeg, { bw });
    const st = await fsp.stat(path.join(PHOTOS_DIR, jpeg));
    // Pre-generate the preview so the tablet shows it quickly
    await resized(jpeg, 'view').catch(() => {});
    const photo = toDto({ name: jpeg, mtime: st.mtimeMs, size: st.size });
    broadcast({ type: 'photo', photo });
    setPhase('idle');
  } catch (err) {
    console.error('[shoot] error:', err.stderr || err.message);
    const m = err.userMessage || (err.textKey ? { camera: err.textKey } : { key: 'shoot.error' });
    broadcast({ type: 'error', message: translate(m) });
    setPhase('idle');
  } finally {
    state.busy = false;
    live.stop(); // safety: live view is always stopped after a shot
  }
}

/**
 * Frame and/or black & white: the original files (JPEG, RAW; in colour, without frame)
 * move to photos/originals/ and the processed version takes the photo's name in photos/.
 */
async function processPhoto(frame, files, jpeg, { bw = false } = {}) {
  const what = [frame && `frame "${frame.label}"`, bw && 'black & white'].filter(Boolean).join(' + ');
  setPhase('framing', { frame: frame ? frame.label : null, bw });
  const t = Date.now();
  for (const f of files) await fsp.rename(path.join(PHOTOS_DIR, f), path.join(ORIGINALS_DIR, f));
  const original = path.join(ORIGINALS_DIR, jpeg);
  const target = path.join(PHOTOS_DIR, jpeg);
  try {
    await frames.apply(frame, original, target, { bw });
    console.log(`[frame] ${what} applied in ${Date.now() - t} ms`);
  } catch (err) {
    console.error('[frame] failed:', err.message);
    await fsp.copyFile(original, target); // the photo stays visible, as is
    broadcast({ type: 'error', message: tr('shoot.retouchFailed') });
  }
  chownSafe(target);
}

/**
 * Checks that the camera responds (and reads its focus mode again when possible).
 * A camera seen on USB but asleep or stuck is reported as an error.
 */
async function probeCamera() {
  if (live.running) return;
  try {
    const p = await camera.probe();
    state.cameraError = null;
    if (camera.capabilities.focusMode && p.focusMode !== state.focusMode) {
      state.focusMode = p.focusMode;
      console.log(`[focus] focus mode: ${p.raw} -> ${p.focusMode}`);
      broadcast({ type: 'focusMode', mode: p.focusMode });
    }
  } catch (err) {
    // camera claimed by another program (e.g. desktop automount): dedicated message
    const claimed = err.textKey === 'claimed';
    const error = { camera: claimed ? 'claimed' : 'unresponsive' };
    if (JSON.stringify(state.cameraError) !== JSON.stringify(error)) {
      console.warn(`[camera] the camera does not respond: ${(err.stderr || err.message || '').trim().split('\n').pop()}`);
    }
    state.cameraError = error;
  }
}
const refreshFocusMode = probeCamera;

// Background camera monitoring, outside of shots:
//  - USB presence every 4 s (plain enumeration, no talking to the camera);
//  - a real exchange (probe) only every 15 s, on every (re)connection, and on request
//    (?probe=1): every gphoto2 session wakes the camera up, and a session cut off
//    mid-exchange can leave it stuck.
const CAMERA_POLL_MS = 4000;
const CAMERA_PROBE_MS = 15000;
let polling = false;
let lastProbe = 0;
let probeRequested = false;
let shuttingDown = false;
async function pollCamera() {
  if (polling || shuttingDown || state.busy || live.running) return;
  polling = true;
  const before = JSON.stringify([state.camera, state.cameraError]);
  try {
    await refreshCamera(probeRequested || Date.now() - lastProbe > CAMERA_PROBE_MS);
  } finally {
    polling = false;
  }
  if (JSON.stringify([state.camera, state.cameraError]) !== before) {
    broadcast({ type: 'camera', camera: state.camera, error: translate(state.cameraError) });
  }
}
setInterval(pollCamera, CAMERA_POLL_MS);

async function refreshCamera(probe = true) {
  // during live view the camera is busy: keep the last known state
  if (live.running) return state;
  try {
    const list = await camera.detect();
    const port = state.camera && state.camera.port;
    state.camera = list[0] || null;
    if (!list.length) {
      state.cameraError = { camera: 'notDetected' };
      return state;
    }
    // camera (re)connected or switched back on: check right away that it responds
    if (probe || state.camera.port !== port) {
      probeRequested = false;
      lastProbe = Date.now();
      await probeCamera();
    }
  } catch (err) {
    state.camera = null;
    state.cameraError = { camera: err.textKey || 'generic' };
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
// Nothing must stay on the tablet: no response is cached by the browser
// (photos, thumbnails, previews, pages). Photos are only retrieved on the host.
app.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0' });
  next();
});
app.get('/diaporama', (_req, res) => res.redirect(301, '/slideshow')); // old address
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], cacheControl: false, etag: false, lastModified: false }));
// No direct access to the original files: photos are retrieved on the host (photos/ folder).

app.get('/api/config', (_req, res) => res.json({ defaultDelay: DEFAULT_DELAY }));

// Immediate answer with the last known state (the camera is polled in the background)
app.get('/api/status', (req, res) => {
  // ?probe=1: the admin page is waiting for a change (e.g. AF/MF) => check on the next round
  if (req.query.probe && Date.now() - lastProbe > 2000) {
    probeRequested = true;
    setImmediate(pollCamera);
  }
  res.json({ camera: state.camera, error: translate(state.cameraError), busy: state.busy, phase: state.phase, focusMode: state.focusMode });
});

app.post('/api/shoot', async (req, res) => {
  if (state.busy) return res.status(409).json({ error: tr('shoot.busy') });
  if (!state.camera || state.cameraError) return res.status(503).json({ error: translate(state.cameraError) || tr('status.noCamera') });
  state.busy = true; // reserved right away (reading the frame is asynchronous)
  // Everything is decided by the admin settings (/admin), not by the tablet
  const delay = DEFAULT_DELAY;
  const conf = settings.get();
  const found = await frames.get(conf.frame).catch(() => null);
  // text and decorations frozen at the time of the photo
  const frame = found ? { ...found, label: frameLabel(found), ...frameOptions(conf) } : null;
  const useLive = conf.live;
  const bw = Boolean(req.body && req.body.bw); // chosen by the guests on the tablet
  runShoot(delay, useLive, frame, { bw }); // asynchronous: progress is sent through /api/events
  res.status(202).json({ ok: true, delay });
});

/* ---------- Settings (admin) ---------- */
async function settingsDto() {
  const conf = settings.get();
  const frame = await frames.get(conf.frame).catch(() => null);
  return {
    ...conf,
    frame: frame ? { id: frame.id, label: frameLabel(frame), preview: framePreviewUrl(frame) } : null,
  };
}

app.get('/api/settings', async (_req, res) => res.json(await settingsDto()));

app.put('/api/settings', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('mirror' in b) patch.mirror = Boolean(b.mirror);
  if ('live' in b) patch.live = Boolean(b.live);
  if ('frameTitle' in b) patch.frameTitle = String(b.frameTitle ?? '');
  if ('frameDeco' in b) patch.frameDeco = Boolean(b.frameDeco);
  if ('theme' in b) {
    if (!themes.isValid(b.theme)) return res.status(400).json({ error: tr('settings.unknownTheme') });
    patch.theme = b.theme;
  }
  if ('lang' in b) {
    if (!i18n.isValid(b.lang)) return res.status(400).json({ error: tr('settings.unknownLang') });
    patch.lang = b.lang;
  }
  if ('frame' in b) {
    if (b.frame && !(await frames.get(b.frame))) return res.status(400).json({ error: tr('settings.unknownFrame') });
    patch.frame = b.frame || null;
  }
  await settings.update(patch, chownSafe);
  const dto = await settingsDto();
  console.log(`[admin] settings: ${JSON.stringify(settings.get())}`);
  broadcast({ type: 'settings', settings: dto });
  res.json(dto);
});

// Camera driver: capabilities and help texts in the UI language
app.get('/api/camera', (_req, res) => {
  res.json({ ...camera.info(), texts: Object.fromEntries(CAMERA_TEXTS.map((n) => [n, cameraText(n)])) });
});

app.get('/api/languages', (_req, res) => res.json(i18n.list()));

/* ---------- Server address for the tablet ---------- */
// Private IPv4 addresses of the host (Wi-Fi / Ethernet), excluding Docker's internal interfaces.
function lanAddresses() {
  const forced = (process.env.HOST_IP || '').trim();
  if (forced) return [{ ip: forced, iface: 'HOST_IP' }];
  const out = [];
  for (const [iface, list] of Object.entries(require('os').networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(iface)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue; // private addresses
      out.push({ ip: a.address, iface });
    }
  }
  // Wi-Fi first
  return out.sort((x, y) => Number(/^w/.test(y.iface)) - Number(/^w/.test(x.iface)));
}
// QR code of the main address (to scan with the tablet)
app.get('/api/network/qr.svg', async (_req, res) => {
  const main = lanAddresses()[0];
  if (!main) return res.sendStatus(404);
  const svg = await QRCode.toString(`http://${main.ip}:${PORT}/`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1b1240', light: '#ffffff' } });
  res.type('svg').send(svg);
});
app.get('/api/network', (_req, res) => {
  res.json({ port: PORT, addresses: lanAddresses().map((a) => ({ ...a, url: `http://${a.ip}:${PORT}` })) });
});

/* ---------- Colour themes ---------- */
app.get('/api/themes', (_req, res) => {
  res.json(themes.list().map((t) => ({ ...t, label: i18n.has(lang(), `themes.${t.id}`) ? tr(`themes.${t.id}`) : t.label })));
});
const themesCss = themes.css();
app.get('/themes.css', (_req, res) => res.type('css').send(themesCss));

// One-off focus on request (e.g. before switching to manual focus)
app.post('/api/focus', async (_req, res) => {
  if (state.busy) return res.status(409).json({ error: tr('shoot.busy') });
  if (!state.camera || state.cameraError) return res.status(503).json({ error: translate(state.cameraError) || tr('status.noCamera') });
  state.busy = true;
  try {
    const r = await camera.autofocus();
    if (r.ok) return res.json({ ok: true });
    const error = r.skipped ? cameraText('autofocusUnsupported') : r.error ? cameraText(r.error) : tr('shoot.focusError');
    res.status(500).json({ error });
  } finally {
    state.busy = false;
  }
});

app.get('/api/photos', async (_req, res, next) => {
  try {
    res.json(await listPhotos());
  } catch (e) {
    next(e);
  }
});

app.get('/media/:kind(thumb|view)/:name', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.sendStatus(400);
  try {
    const file = await resized(name, req.params.kind);
    res.sendFile(file);
  } catch (e) {
    res.sendStatus(e.code === 'ENOENT' ? 404 : 500);
  }
});

app.get('/api/frames', async (_req, res) => {
  const list = await frames.list();
  res.json(list.map((f) => ({ id: f.id, label: frameLabel(f), preview: framePreviewUrl(f) })));
});

app.get('/api/frames/:id.png', async (req, res) => {
  const frame = await frames.get(req.params.id);
  if (!frame) return res.sendStatus(404);
  try {
    res.type('png').send(await frames.preview(frame, frameOptions()));
  } catch (err) {
    console.error('[frame] preview:', err.message);
    res.sendStatus(500);
  }
});

app.get('/api/live.mjpeg', (req, res) => live.addViewer(req, res));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', busy: state.busy, phase: state.phase, live: live.state })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Camera driver: ${camera.id} (${camera.label})`);
  console.log(`Flash & Furious ready on http://0.0.0.0:${PORT} — photos in ${PHOTOS_DIR}`);
  await refreshCamera();
  console.log(state.camera ? `Camera detected: ${state.camera.model} (${state.camera.port})` : `Camera: ${translate(state.cameraError)}`);
});

// Clean shutdown (docker stop / restart): stop monitoring, close live view and WAIT for
// the current command to finish. Cutting the camera off mid-exchange can leave it stuck
// (it then has to be switched off and on again).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${sig} received: clean shutdown (live view + current command)…`);
    const force = setTimeout(() => process.exit(0), 12000);
    try {
      await live.stop();
      await camera.exclusive(() => {}); // waits until the camera queue is empty
      console.log('[server] camera released, exiting.');
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  });
}
