'use strict';

/**
 * Green screen images: the backgrounds (backgrounds/ folder: JPEG, PNG or SVG, ideally 3:2),
 * calibration, previews, and the green replaced on a photo.
 *
 * The pixel work (key.js) runs in a worker thread: a full-size photo
 * takes a moment, and the server must stay responsive meanwhile (countdown, live view).
 */

const path = require('path');
const fsp = require('fs').promises;
const { Worker } = require('worker_threads');
const sharp = require('sharp');
const key = require('./key');

const BACKGROUNDS_DIR = path.resolve(process.env.BACKGROUNDS_DIR || path.join(__dirname, '..', '..', 'backgrounds'));
const BACKGROUND_RE = /\.(jpe?g|png|svg)$/i;

function labelFromFile(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d+[-_ ]*/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Available backgrounds: [{ id, label, file, mtime }], sorted by file name. */
async function list() {
  let entries = [];
  try {
    entries = await fsp.readdir(BACKGROUNDS_DIR);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const file of entries.filter((f) => BACKGROUND_RE.test(f) && !f.startsWith('.')).sort()) {
    const full = path.join(BACKGROUNDS_DIR, file);
    const st = await fsp.stat(full);
    let label = labelFromFile(file);
    if (/\.svg$/i.test(file)) {
      const m = (await fsp.readFile(full, 'utf8')).match(/<title>([^<]+)<\/title>/i);
      if (m) label = m[1].trim();
    }
    out.push({ id: path.basename(file, path.extname(file)), label, file: full, mtime: st.mtimeMs });
  }
  return out;
}

async function get(id) {
  if (!id) return null;
  return (await list()).find((b) => b.id === id) || null;
}

/** The background at exactly this size (cropped to fill it), as a sharp pipeline. */
function backgroundImage(bg, width, height) {
  let input = sharp(bg.file);
  if (/\.svg$/i.test(bg.file)) {
    // density matched to the final size so the SVG renders sharply
    input = sharp(bg.file, { density: Math.min(2400, Math.max(72, (72 * Math.max(width, height * 1.5)) / 1500)) });
  }
  return input.rotate().resize(width, height, { fit: 'cover' }).removeAlpha();
}

/**
 * Background pixels for one photo size, kept for the next shots (same background and size
 * for a whole event): the screen size and the full size, the last two only.
 * In shared memory: the worker reads them without a copy.
 */
const backgroundCache = new Map();
function backgroundPixels(bg, width, height) {
  const id = [bg.id, bg.mtime, width, height].join(':');
  if (!backgroundCache.has(id)) {
    while (backgroundCache.size >= 2) backgroundCache.delete(backgroundCache.keys().next().value);
    const job = backgroundImage(bg, width, height)
      .raw()
      .toBuffer()
      .then((data) => {
        const shared = new SharedArrayBuffer(data.length);
        new Uint8Array(shared).set(data);
        return shared;
      })
      .catch((err) => {
        backgroundCache.delete(id);
        throw err;
      });
    backgroundCache.set(id, job);
  }
  return backgroundCache.get(id);
}

/* ---------- Worker thread ---------- */
let worker = null;
let nextJob = 1;
const jobs = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'worker.js'));
  worker.unref(); // does not keep the process alive
  worker.on('message', ({ id, error }) => {
    const job = jobs.get(id);
    jobs.delete(id);
    if (!jobs.size) worker.unref();
    if (job) (error ? job.reject(new Error(error)) : job.resolve());
  });
  const failed = (err) => {
    for (const job of jobs.values()) job.reject(err);
    jobs.clear();
    worker = null; // a new one next time
  };
  worker.on('error', failed);
  worker.on('exit', (code) => worker && failed(new Error(`green screen worker stopped (${code})`)));
  return worker;
}
function inWorker(msg) {
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    jobs.set(id, { resolve, reject });
    const w = getWorker();
    w.ref(); // kept alive while it works
    w.postMessage({ id, ...msg });
  });
}

/**
 * Replaces the green of an RGB image (raw pixels from sharp) with the background.
 * @param {{ data: Buffer, info: { width, height, channels } }} img 3 channels
 * @param {{ background: object, key: object|null, tolerance: number }} green
 * @returns {Promise<Buffer>} RGB pixels, same size
 */
async function composite({ data, info }, green) {
  const { width, height } = info;
  const background = await backgroundPixels(green.background, width, height);
  const photo = new SharedArrayBuffer(data.length);
  new Uint8Array(photo).set(data);
  await inWorker({ photo, background, width, height, params: key.params(green.key, green.tolerance, width) });
  return Buffer.from(photo);
}

/** RGB pixels of an image file, "the right way up", at most `size` px wide or high. */
async function rgb(file, size) {
  return sharp(file)
    .rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/**
 * Calibration from a photo of the green cloth: the thresholds, and a small copy of the
 * photo (`sample`, for the previews in /admin).
 * @throws {Error} code 'notGreen' when no green cloth is seen
 */
async function calibrate(photoFile, sampleFile) {
  const small = await rgb(photoFile, 1200);
  const result = key.calibrate(small.data, small.info.width, small.info.height);
  await sharp(small.data, { raw: small.info }).jpeg({ quality: 88 }).toFile(sampleFile);
  return result;
}

/** The calibration photo with its green replaced (preview in /admin), JPEG. */
async function preview(sampleFile, green) {
  const img = await rgb(sampleFile, 1200);
  const out = await composite(img, green);
  return sharp(out, { raw: img.info }).jpeg({ quality: 85 }).toBuffer();
}

/** Small picture of a background (picker in /admin), JPEG, cached in memory. */
const thumbCache = new Map();
function thumbnail(bg) {
  const id = `${bg.id}:${bg.mtime}`;
  if (thumbCache.size > 50) thumbCache.clear();
  if (!thumbCache.has(id)) {
    const job = backgroundImage(bg, 600, 400).jpeg({ quality: 82 }).toBuffer();
    thumbCache.set(id, job.catch((e) => { thumbCache.delete(id); throw e; }));
  }
  return thumbCache.get(id);
}

module.exports = { list, get, composite, calibrate, preview, thumbnail, BACKGROUNDS_DIR, labelFromFile };
