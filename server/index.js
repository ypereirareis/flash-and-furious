'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const express = require('express');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const QRCode = require('qrcode');
const camera = require('./cameras'); // camera driver (CAMERA_DRIVER)
const live = require('./live');
const photo = require('./photo');
const features = require('./features'); // feature modules (features/ folder, FEATURES)
const settings = require('./settings');
const themes = require('./themes');
const i18n = require('./i18n');
const storage = require('./storage');
const journal = require('./journal');
let shuttingDown = false; // set by SIGTERM / SIGINT (clean stop)
const { IMAGE_RE, safeName, timestamp, toDto, lanAddresses } = require('./photos');

const PORT = Number(process.env.PORT || 3000);
const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || path.join(__dirname, '..', 'photos'));
const CACHE_DIR = path.join(PHOTOS_DIR, '.cache');
const ORIGINALS_DIR = path.join(PHOTOS_DIR, 'originals');
const DEFAULT_DELAY = clampInt(process.env.DEFAULT_DELAY, 0, 30, 3);
// How many seconds before the end of the countdown focusing starts
const FOCUS_BEFORE_END = clampInt(process.env.FOCUS_BEFORE_END, 0, 10, 2);
// Message shown before the countdown, with a smaller reminder below it.
// Unset = translated default text; empty = nothing.
const PRE_MESSAGE = process.env.PRE_MESSAGE;
const LOOK_MESSAGE = process.env.LOOK_MESSAGE;
const PRE_MESSAGE_SECONDS = clampInt(process.env.PRE_MESSAGE_SECONDS, 0, 10, 2);
const LOOK_MESSAGE_SECONDS = clampInt(process.env.LOOK_MESSAGE_SECONDS, 0, 10, 2);
const PUID = process.env.PUID ? Number(process.env.PUID) : null;
const PGID = process.env.PGID ? Number(process.env.PGID) : null;

// Normally prepared by docker/entrypoint.sh; a storage problem must not stop the server
// (it is reported in /admin and on the tablet, and photos are refused).
for (const dir of [CACHE_DIR, ORIGINALS_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    chownSafe(dir);
  } catch (err) {
    console.error(`[storage] cannot create ${dir}: ${err.message}`);
  }
}
// What the feature modules may use from the app (see features.js)
features.load({
  settings, i18n, journal, themes, express, features,
  lang: () => lang(),
  tr: (key, vars) => tr(key, vars),
  translate: (m) => translate(m),
  chownSafe, cameraUnavailable, captureAside, settingsChanged,
});
settings.load();
chownSafe(settings.CONFIG_DIR);
journal.load(settings.CONFIG_DIR);

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
/* Photo storage                                                       */
/* ------------------------------------------------------------------ */
let lastStorageProblem = null;
/**
 * Problem preventing photos from being saved, as an untranslated message, or null.
 * { probe: true } also makes a real write test (right before and after a photo).
 */
function storageError({ probe = false } = {}) {
  const problem = storage.check(PHOTOS_DIR, settings.CONFIG_DIR, { probe });
  if (problem !== lastStorageProblem) {
    if (problem) {
      console.error(`[storage] photos blocked: ${problem} (${PHOTOS_DIR})`);
      journal.add('error', 'storage', 'journal.storageBlocked', { reason: { key: `storage.${problem}` } });
    } else if (lastStorageProblem) {
      console.log('[storage] photos folder OK again');
      journal.add('success', 'storage', 'journal.storageOk');
    }
    lastStorageProblem = problem;
  }
  return problem ? { key: `storage.${problem}` } : null;
}
/** What currently prevents taking a photo: storage first, then the camera. */
const blockingError = () => storageError() || state.cameraError;

/* ------------------------------------------------------------------ */
/* Real-time events (Server-Sent Events)                               */
/* ------------------------------------------------------------------ */
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

live.on('state', ({ state: s, textKey }) => {
  broadcast({ type: 'live', state: s, message: textKey ? cameraText(textKey) : undefined });
  if (s === 'error') journal.add('warning', 'camera', 'journal.liveProblem', { reason: { camera: textKey } });
});

/* ------------------------------------------------------------------ */
/* Event journal (/admin)                                              */
/* ------------------------------------------------------------------ */
/**
 * Journal entry in the current UI language. A value can itself be a message ({ key } or
 * { camera }), or a list of messages (joined with commas).
 */
function journalDto(e) {
  const text = (v) => (Array.isArray(v) ? v.map(translate).join(', ') : v && typeof v === 'object' ? translate(v) : v);
  const vars = Object.fromEntries(Object.entries(e.vars || {}).map(([k, v]) => [k, text(v)]));
  return { id: e.id, at: e.at, level: e.level, category: e.category, message: tr(e.key, vars), detail: e.detail || null };
}
journal.onAdd((e) => broadcast({ type: 'journal', entry: journalDto(e) }));

// Camera state as written in the journal: only changes are written (it is polled every 4 s)
let journalCameraState = null;
function journalCamera() {
  if (shuttingDown) return; // a poll ending during the stop: not news
  const now = JSON.stringify([state.camera && state.camera.model, state.cameraError]);
  if (now === journalCameraState) return;
  journalCameraState = now;
  if (state.cameraError) journal.add('warning', 'camera', 'journal.cameraProblem', { reason: state.cameraError });
  else if (state.camera) journal.add('success', 'camera', 'journal.cameraConnected', { model: state.camera.model });
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */
async function listPhotos() {
  const entries = await fsp.readdir(PHOTOS_DIR, { withFileTypes: true });
  const photos = [];
  for (const e of entries) {
    if (!e.isFile() || !IMAGE_RE.test(e.name) || e.name.startsWith('.')) continue;
    const st = await fsp.stat(path.join(PHOTOS_DIR, e.name));
    photos.push({ name: e.name, mtime: st.mtimeMs, size: st.size });
  }
  // photos whose full-size version is still being computed are already shown
  for (const [name, job] of processing) {
    if (!photos.some((p) => p.name === name)) photos.push({ name, mtime: job.mtime, size: 0 });
  }
  photos.sort((a, b) => b.mtime - a.mtime);
  return photos.map(toDto);
}

// thumb: gallery; view: tablet; tv: slideshow on a 4K screen
const SIZES = { thumb: 480, view: 1920, tv: 3840 };
const QUALITY = { thumb: 72, view: 85, tv: 85 };
const pending = new Map();

/** Generates (and caches) a resized copy, correctly oriented (EXIF). */
async function resized(name, kind) {
  // photo still being processed at full size: its screen version stands in for it, except
  // for the 4K version, made from the full-size photo once ready
  const job = processing.get(name);
  if (job && kind === 'tv') await job.done;
  const src = processing.has(name) ? screenFile(name) : path.join(PHOTOS_DIR, name);
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
        .jpeg({ quality: QUALITY[kind], mozjpeg: kind !== 'tv' }) // mozjpeg: slow at 4K
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
/* Shooting                                                            */
/* ------------------------------------------------------------------ */
const state = { busy: false, phase: 'idle', camera: null, cameraError: null, focusMode: null };

function setPhase(phase, extra = {}) {
  state.phase = phase;
  broadcast({ type: 'phase', phase, ...extra });
}

const fail = (message, reason) => Object.assign(new Error(reason), { userMessage: message });

/** Why no photo can be taken right now, as { status, error } (translated), or null. */
function cameraUnavailable() {
  if (state.busy) return { status: 409, error: tr('shoot.busy') };
  const storageProblem = storageError({ probe: true }); // real write test before every photo (disk unplugged?)
  if (storageProblem) return { status: 503, error: translate(storageProblem) };
  if (!state.camera || state.cameraError) return { status: 503, error: translate(state.cameraError) || tr('status.noCamera') };
  return null;
}

/**
 * Photo outside the gallery (e.g. green screen calibration), taken with the camera reserved
 * into a temporary folder: fn(jpegFile, or null if none came) uses it, then it is deleted.
 * @returns what fn returns
 */
async function captureAside(name, fn) {
  state.busy = true;
  const dir = path.join(CACHE_DIR, `${name}-${Date.now()}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await refreshFocusMode();
    const manual = state.focusMode === 'manual';
    await live.stop();
    if (!manual) await camera.autofocus();
    const jpegIn = async () => {
      const f = (await fsp.readdir(dir)).find((x) => IMAGE_RE.test(x));
      return f ? path.join(dir, f) : null;
    };
    await camera.capture(dir, name);
    let photo = await jpegIn();
    if (!photo && camera.shouldRetryWithoutFile({ manual })) {
      await camera.autofocus();
      await camera.capture(dir, name);
      photo = await jpegIn();
    }
    return await fn(photo);
  } finally {
    state.busy = false;
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A photo, from the countdown to the gallery. `edits`: what is applied to it, frozen at the
 * time of the shot: { moduleId: data } (see features.forShot).
 */
async function runShoot(delay, useLive, edits) {
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
    // Two messages, one after the other, before the countdown:
    // "look at the lens, not the screen", then "don't move until the flash"
    const look = LOOK_MESSAGE ?? tr('shoot.lookMessage');
    if (look && LOOK_MESSAGE_SECONDS > 0) {
      setPhase('look', { message: look });
      await sleep(LOOK_MESSAGE_SECONDS * 1000);
    }
    const message = PRE_MESSAGE ?? tr('shoot.preMessage');
    if (message && PRE_MESSAGE_SECONDS > 0) {
      setPhase('warning', { message });
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
    // No file because it could not be saved (disk unplugged, folder deleted...)?
    // Then retrying would only fire the camera again for nothing.
    const checkSaved = () => {
      const problem = !files.length && storageError({ probe: true });
      if (problem) throw fail(problem, 'storage');
    };
    checkSaved();
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
      checkSaved();
      if (!files.length) {
        console.warn(`[shoot] still no photo. Camera: ${short(out)}`);
        throw fail({ camera: 'focusFailed' }, 'no file');
      }
    }

    files.forEach((f) => chownSafe(path.join(PHOTOS_DIR, f)));
    const jpeg = files.find((f) => IMAGE_RE.test(f));
    console.log(`[shoot] ${files.join(', ') || 'no file'} in ${Date.now() - before} ms`);

    if (!jpeg) throw fail({ key: files.length ? 'shoot.noJpeg' : 'shoot.noFiles' }, 'no jpeg');
    if (Object.keys(edits).length) await processPhoto(files, jpeg, edits);
    const job = processing.get(jpeg);
    const mtime = job ? job.mtime : (await fsp.stat(path.join(PHOTOS_DIR, jpeg))).mtimeMs;
    // Pre-generate the screen versions: the tablet one is awaited, the 4K one (TV)
    // follows in the background (after the full-size photo if it is being processed)
    await resized(jpeg, 'view').catch(() => {});
    resized(jpeg, 'tv').catch(() => {});
    const photo = toDto({ name: jpeg, mtime });
    broadcast({ type: 'photo', photo });
    const details = features.journalDetails(edits);
    journal.add('success', 'photo', details.length ? 'journal.photoWith' : 'journal.photo', details.length ? { details } : {}, jpeg);
    setPhase('idle');
  } catch (err) {
    console.error('[shoot] error:', err.stderr || err.message);
    const m = err.userMessage || (err.textKey ? { camera: err.textKey } : { key: 'shoot.error' });
    broadcast({ type: 'error', message: translate(m) });
    journal.add('error', 'photo', 'journal.shootFailed', { reason: m });
    setPhase('idle');
  } finally {
    state.busy = false;
    live.stop(); // safety: live view is always stopped after a shot
  }
}

/* ------------------------------------------------------------------ */
/* Photo processing (edits of the feature modules)                     */
/* ------------------------------------------------------------------ */
/** Applies the edits of a photo to `src`, written to `dst` (JPEG). */
function edit(edits, src, dst, opts = {}) {
  return photo.process(src, dst, { ...features.steps(edits), ...opts });
}
/** Message on the tablet while a photo is edited: { icon, message }. */
function editStep(edits) {
  const s = features.step(edits) || { icon: '✨', key: 'booth.editing' };
  return { icon: s.icon, message: tr(s.key) };
}

// The guests only wait for the tablet version (1920 px, a fraction of a second); the
// full-size photo, then its 4K version for the TV, are computed afterwards in a queue,
// one photo at a time, so the next shot can start right away.
// Photos waiting for their full-size version: name -> { mtime, done }
const processing = new Map();
let processingQueue = Promise.resolve();
// tablet version of a photo being processed: directly its cached "view" copy
const screenFile = (name) => path.join(CACHE_DIR, `view_${name}`);
// job written to disk until the full-size photo exists: resumed after a restart or a power cut
const jobFile = (name) => path.join(CACHE_DIR, `pending_${name}.json`);

/**
 * Edited photo: the original files (JPEG, RAW; as taken) move to photos/originals/ and the
 * edited version takes the photo's name in photos/.
 */
async function processPhoto(files, jpeg, edits) {
  const what = features.journalDetails(edits).map(translate).join(' + ');
  setPhase('framing', editStep(edits));
  const t = Date.now();
  for (const f of files) await fsp.rename(path.join(PHOTOS_DIR, f), path.join(ORIGINALS_DIR, f));
  const original = path.join(ORIGINALS_DIR, jpeg);
  const job = { name: jpeg, edits, mtime: Date.now() };
  try {
    const tmp = `${screenFile(jpeg)}.tmp`;
    await edit(edits, original, tmp, { maxSize: SIZES.view, quality: QUALITY.view });
    await fsp.rename(tmp, screenFile(jpeg));
    chownSafe(screenFile(jpeg));
    await fsp.writeFile(jobFile(jpeg), JSON.stringify(job));
    chownSafe(jobFile(jpeg));
    console.log(`[photo] ${what}: screen version in ${Date.now() - t} ms, full size queued`);
  } catch (err) {
    console.error('[photo] edit failed:', err.message);
    await fsp.rm(screenFile(jpeg), { force: true });
    await fsp.copyFile(original, path.join(PHOTOS_DIR, jpeg)); // the photo stays visible, as is
    chownSafe(path.join(PHOTOS_DIR, jpeg));
    broadcast({ type: 'error', message: tr('shoot.retouchFailed') });
    journal.add('warning', 'photo', 'journal.retouchFailed', {}, jpeg);
    return;
  }
  queueFullSize(job);
}

function queueFullSize(job) {
  const done = processingQueue
    .then(() => fullSize(job))
    .catch((err) => console.error(`[photo] ${job.name}:`, err.message));
  processing.set(job.name, { mtime: job.mtime, done });
  processingQueue = done;
}

/** Full-size version of a queued photo, written to photos/ once complete. */
async function fullSize(job) {
  const { name, mtime } = job;
  const original = path.join(ORIGINALS_DIR, name);
  const target = path.join(PHOTOS_DIR, name);
  const tmp = path.join(PHOTOS_DIR, `.${name}.tmp`); // hidden: not listed while being written
  const t = Date.now();
  try {
    await edit(job.edits || {}, original, tmp);
    await fsp.rename(tmp, target);
    console.log(`[photo] ${name}: full size in ${Date.now() - t} ms`);
  } catch (err) {
    console.error(`[photo] ${name}: full size failed:`, err.message);
    await fsp.rm(tmp, { force: true });
    await fsp.copyFile(original, target); // the photo stays, as is
    // the screen versions show the edits: they are made again from the photo as is
    await Promise.all(Object.keys(SIZES).map((k) => fsp.rm(path.join(CACHE_DIR, `${k}_${name}`), { force: true })));
    broadcast({ type: 'error', message: tr('shoot.retouchFailed') });
    journal.add('warning', 'photo', 'journal.retouchFailed', {}, name);
  } finally {
    processing.delete(name);
  }
  // the photo keeps the time of the shot: gallery order, and the screen versions
  // (made after it) stay valid in the cache
  const when = new Date(mtime);
  await fsp.utimes(target, when, when);
  chownSafe(target);
  await fsp.rm(jobFile(name), { force: true });
}

/** Full-size versions left unfinished (restart, power cut): queued again. */
async function resumeProcessing() {
  let files = [];
  try {
    files = (await fsp.readdir(CACHE_DIR)).filter((f) => /^pending_.+\.json$/.test(f));
  } catch (_) {
    return;
  }
  let resumed = 0;
  for (const f of files) {
    try {
      const job = JSON.parse(await fsp.readFile(path.join(CACHE_DIR, f), 'utf8'));
      if (!safeName(job.name) || `pending_${job.name}.json` !== f) throw new Error('invalid job');
      console.log(`[photo] ${job.name}: full size resumed`);
      queueFullSize(job);
      resumed += 1;
    } catch (err) {
      console.error(`[photo] ${f}: cannot resume (${err.message})`);
    }
  }
  if (resumed) journal.add('info', 'photo', 'journal.resumed', { count: resumed });
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
      if (p.focusMode && !shuttingDown) journal.add('info', 'camera', p.focusMode === 'manual' ? 'journal.focusManual' : 'journal.focusAuto');
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
async function pollCamera() {
  if (polling || shuttingDown || state.busy || live.running) return;
  polling = true;
  const before = JSON.stringify([state.camera, blockingError()]);
  try {
    await refreshCamera(probeRequested || Date.now() - lastProbe > CAMERA_PROBE_MS);
  } finally {
    polling = false;
  }
  const error = blockingError();
  if (JSON.stringify([state.camera, error]) !== before) {
    broadcast({ type: 'camera', camera: state.camera, error: translate(error) });
  }
  journalCamera();
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
// Limit per device on the routes that read files or compute images (photos, frame
// previews): a device of the local network cannot keep the host busy. Generous for normal
// use: the gallery loads its thumbnails as they scroll into view.
const rateLimited = new Map(); // device -> last time written in the journal
app.use(
  ['/api', '/media'],
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      // written once a minute at most per device
      if (Date.now() - (rateLimited.get(req.ip) || 0) > 60 * 1000) {
        rateLimited.set(req.ip, Date.now());
        journal.add('warning', 'system', 'journal.rateLimited', { ip: req.ip });
      }
      res.status(429).json({ error: tr('status.tooManyRequests') });
    },
  })
);
const STATIC_OPTIONS = { extensions: ['html'], cacheControl: false, etag: false, lastModified: false };
// Texts for the browser: the app's and those of the feature modules
app.get('/locales/:lang.json', (req, res) => (i18n.isValid(req.params.lang) ? res.json(i18n.dict(req.params.lang)) : res.sendStatus(404)));
app.use(express.static(path.join(__dirname, '..', 'public'), STATIC_OPTIONS));
// No direct access to the original files: photos are retrieved on the host (photos/ folder).

app.get('/api/config', (_req, res) => res.json({ defaultDelay: DEFAULT_DELAY }));
// Active feature modules and their files for the screens (see public/features.js)
app.get('/api/features', (_req, res) => res.json(features.ui()));

// Immediate answer with the last known state (the camera is polled in the background)
app.get('/api/status', (req, res) => {
  // ?probe=1: the admin page is waiting for a change (e.g. AF/MF) => check on the next round
  if (req.query.probe && Date.now() - lastProbe > 2000) {
    probeRequested = true;
    setImmediate(pollCamera);
  }
  res.json({ camera: state.camera, error: translate(blockingError()), busy: state.busy, phase: state.phase, focusMode: state.focusMode });
});

app.post('/api/shoot', async (req, res) => {
  const unavailable = cameraUnavailable();
  if (unavailable) return res.status(unavailable.status).json({ error: unavailable.error });
  state.busy = true; // reserved right away (reading the frame is asynchronous)
  // Everything is decided by the admin settings (/admin), not by the tablet
  const delay = DEFAULT_DELAY;
  const conf = settings.get();
  // edits of the feature modules, frozen at the time of the photo (some chosen on the tablet)
  const edits = await features.forShot(conf, req.body || {});
  runShoot(delay, conf.live, edits); // asynchronous: progress is sent through /api/events
  res.status(202).json({ ok: true, delay });
});

/* ---------- Settings (admin) ---------- */
async function settingsDto() {
  const conf = settings.get();
  const dto = { ...conf, ...(await features.settingsDto(conf)) };
  for (const k of features.inactiveKeys()) delete dto[k]; // settings of the modules switched off
  return dto;
}
/** Settings changed: sent to every screen, and returned (for /admin). */
async function settingsChanged() {
  const dto = await settingsDto();
  broadcast({ type: 'settings', settings: dto });
  return dto;
}

app.get('/api/settings', async (_req, res) => res.json(await settingsDto()));

app.put('/api/settings', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('mirror' in b) patch.mirror = Boolean(b.mirror);
  if ('live' in b) patch.live = Boolean(b.live);
  if ('theme' in b) {
    if (!themes.isValid(b.theme)) return res.status(400).json({ error: tr('settings.unknownTheme') });
    patch.theme = b.theme;
  }
  if ('lang' in b) {
    if (!i18n.isValid(b.lang)) return res.status(400).json({ error: tr('settings.unknownLang') });
    patch.lang = b.lang;
  }
  // the feature modules' own settings
  const fromModules = await features.settingsPatch(b);
  if (fromModules.error) return res.status(400).json({ error: fromModules.error });
  Object.assign(patch, fromModules.patch);
  const old = settings.get();
  await settings.update(patch, chownSafe);
  await journalSettings(old, settings.get());
  console.log(`[admin] settings: ${JSON.stringify(settings.get())}`);
  res.json(await settingsChanged());
});

/** Settings changed in /admin, one journal entry per change. */
async function journalSettings(old, now) {
  const add = (key, vars) => journal.add('info', 'settings', key, vars);
  if (now.theme !== old.theme) add('journal.settingTheme', { value: { key: `themes.${now.theme}` } });
  if (now.live !== old.live) add(now.live ? 'journal.settingLiveOn' : 'journal.settingLiveOff');
  if (now.mirror !== old.mirror) add(now.mirror ? 'journal.settingMirrorOn' : 'journal.settingMirrorOff');
  if (now.lang !== old.lang) add('journal.settingLang', { value: (i18n.list().find((l) => l.id === now.lang) || {}).label });
  await features.journalSettings(old, now, add);
}

// Camera driver: capabilities and help texts in the UI language
app.get('/api/camera', (_req, res) => {
  res.json({ ...camera.info(), texts: Object.fromEntries(CAMERA_TEXTS.map((n) => [n, cameraText(n)])) });
});

app.get('/api/languages', (_req, res) => res.json(i18n.list()));

/* ---------- Server address for the tablet ---------- */
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

app.get('/media/:kind(thumb|view|tv)/:name', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.sendStatus(400);
  try {
    const file = await resized(name, req.params.kind);
    res.sendFile(file);
  } catch (e) {
    res.sendStatus(e.code === 'ENOENT' ? 404 : 500);
  }
});

// Event journal, newest first; ?before=<id> for the next page (older entries)
app.get('/api/journal', (req, res) => {
  const { entries, more } = journal.page({ before: req.query.before, limit: req.query.limit });
  res.json({ entries: entries.map(journalDto), more });
});

/* ---------- Feature modules: their routes and screen files ---------- */
features.mount(app, express, STATIC_OPTIONS);

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
  journal.add('info', 'system', 'journal.started');
  storageError(); // logs a storage problem right away
  await resumeProcessing();
  await refreshCamera();
  journalCamera();
  console.log(state.camera ? `Camera detected: ${state.camera.model} (${state.camera.port})` : `Camera: ${translate(state.cameraError)}`);
});

// Clean shutdown (docker stop / restart): stop monitoring, close live view and WAIT for
// the current command to finish. Cutting the camera off mid-exchange can leave it stuck
// (it then has to be switched off and on again).
process.on('exit', () => journal.flushSync()); // also on a forced exit or an error during the stop
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${sig} received: clean shutdown (live view + current command)…`);
    if (processing.size) journal.add('info', 'system', 'journal.stoppingWait', { count: processing.size });
    else journal.add('info', 'system', 'journal.stopping');
    const force = setTimeout(() => process.exit(0), 12000);
    try {
      await live.stop();
      await camera.exclusive(() => {}); // waits until the camera queue is empty
      console.log('[server] camera released.');
      // photos left unfinished are resumed at the next start (pending_*.json)
      if (processing.size) console.log(`[server] waiting for ${processing.size} photo(s) being processed…`);
      await processingQueue;
      await journal.close(); // entries still waiting to be written
      console.log('[server] exiting.');
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  });
}
