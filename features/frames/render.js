'use strict';

/**
 * Frame images: PNG (transparent) or SVG files from the frames/ folder.
 * In SVGs, {{title}} and {{date}} are replaced at render time.
 */

const path = require('path');
const fsp = require('fs').promises;
const sharp = require('sharp');
const { toRaw, rawLayer } = require('../../server/photo');

const FRAMES_DIR = path.resolve(process.env.FRAMES_DIR || path.join(__dirname, '..', '..', 'frames'));
const FRAME_RE = /\.(png|svg)$/i;

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Today's date, written out in the given locale (e.g. "24 November 2026"). */
function today(locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}

function labelFromFile(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d+[-_ ]*/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Available frames: [{ id, label, file, mtime }] */
async function list() {
  let entries = [];
  try {
    entries = await fsp.readdir(FRAMES_DIR);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const file of entries.filter((f) => FRAME_RE.test(f) && !f.startsWith('.')).sort()) {
    const full = path.join(FRAMES_DIR, file);
    let label = labelFromFile(file);
    let mtime;
    // one open file for its date and its contents (both read from the same file)
    const fh = await fsp.open(full, 'r').catch(() => null);
    if (!fh) continue;
    try {
      mtime = (await fh.stat()).mtimeMs;
      if (/\.svg$/i.test(file)) {
        const m = (await fh.readFile('utf8')).match(/<title>([^<]+)<\/title>/i);
        if (m) label = m[1].trim();
      }
    } finally {
      await fh.close();
    }
    out.push({ id: path.basename(file, path.extname(file)), label, file: full, mtime });
  }
  return out;
}

async function get(id) {
  if (!id) return null;
  return (await list()).find((f) => f.id === id) || null;
}

/**
 * Width-limited texts: a <text data-fit="500" font-size="46"> gets a smaller font size
 * when its content (e.g. a long title) is wider than 500 units.
 * Estimate: data-char-width (0.6 by default) × font size per character.
 */
function fitTexts(svg) {
  return svg.replace(/<text\b([^>]*?)\sdata-fit="(\d+(?:\.\d+)?)"([^>]*)>([^<]*)<\/text>/g, (all, before, maxW, after, content) => {
    const attrs = `${before}${after}`;
    const m = attrs.match(/font-size="(\d+(?:\.\d+)?)"/);
    if (!m) return all;
    const size = Number(m[1]);
    const cw = attrs.match(/data-char-width="(\d*\.?\d+)"/); // average character width (× size)
    const chars = content.replace(/&[a-z#0-9]+;/gi, 'x').length || 1;
    const fitted = Math.min(size, Number(maxW) / ((cw ? Number(cw[1]) : 0.6) * chars));
    return `<text${attrs.replace(m[0], `font-size="${fitted.toFixed(1)}"`)}>${content}</text>`;
  });
}

/**
 * Splits a raw RGBA layer into rectangles, leaving out its fully transparent areas
 * (the middle of a frame, where the photo shows): compositing them changes nothing, but
 * kept in memory they weigh most of the layer (96 MB for a 24 Mpx photo).
 * The image is cut into TILE × TILE squares; the non-empty ones, joined into horizontal
 * runs, then runs with the same columns on consecutive rows, give the rectangles.
 */
const TILE = 128;
function opaqueParts({ data, info }) {
  const { width, height, channels } = info;
  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const used = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const tileRow = Math.floor(y / TILE) * cols;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] === 0) continue;
      used[tileRow + Math.floor(x / TILE)] = 1;
      x = (Math.floor(x / TILE) + 1) * TILE - 1; // this tile is used: go to the next one
    }
  }
  // horizontal runs of used tiles, per row of tiles: "c0-c1" -> rectangle being extended
  const rects = [];
  let open = new Map();
  for (let r = 0; r < rows; r++) {
    const next = new Map();
    for (let c = 0; c < cols; c++) {
      if (!used[r * cols + c]) continue;
      const c0 = c;
      while (c + 1 < cols && used[r * cols + c + 1]) c++;
      const key = `${c0}-${c}`;
      const rect = open.get(key) || { c0, c1: c, r0: r, r1: r };
      rect.r1 = r;
      if (!open.has(key)) rects.push(rect);
      next.set(key, rect);
    }
    open = next;
  }
  return rects.map(({ c0, c1, r0, r1 }) => {
    const left = c0 * TILE;
    const top = r0 * TILE;
    const w = Math.min(width, (c1 + 1) * TILE) - left;
    const h = Math.min(height, (r1 + 1) * TILE) - top;
    const part = Buffer.allocUnsafe(w * h * channels);
    for (let y = 0; y < h; y++) {
      const from = ((top + y) * width + left) * channels;
      data.copy(part, y * w * channels, from, from + w * channels);
    }
    return rawLayer({ data: part, info: { width: w, height: h, channels } }, { left, top });
  });
}

/** Frame layers for an image of this size, its fully transparent middle left out. */
async function layers(frame, width, height, { title = '', locale } = {}) {
  return opaqueParts(await renderFrame(frame, width, height, title, today(locale)));
}

/**
 * Renders the frame (and what the other modules lay over the photos, e.g. the theme
 * decorations) as a transparent PNG.
 * @param {object} opts { title: replaces {{title}}, locale: for {{date}},
 *   others: { key, render(width, height) -> layers } (see features.otherLayers) }
 */
async function render(frame, width, height, opts) {
  const others = opts.others ? await opts.others.render(width, height) : [];
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...(await layers(frame, width, height, opts)), ...others])
    .png()
    .toBuffer();
}

async function renderFrame(frame, width, height, title, date) {
  if (/\.svg$/i.test(frame.file)) {
    const svg = fitTexts(
      (await fsp.readFile(frame.file, 'utf8'))
        .replace(/\{\{\s*title\s*\}\}/g, xmlEscape(title))
        .replace(/\{\{\s*date\s*\}\}/g, xmlEscape(date))
    );
    // density matched to the final size so the SVG renders sharply
    const vb = svg.match(/viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"/);
    const svgWidth = vb ? Number(vb[1]) : 1500;
    const density = Math.min(2400, Math.max(72, (72 * width) / svgWidth));
    return toRaw(sharp(Buffer.from(svg), { density }).resize(width, height, { fit: 'fill' }));
  }
  return toRaw(sharp(frame.file).resize(width, height, { fit: 'fill' }));
}

/** Lightweight preview (for the tablet and admin), cached in memory. */
const previewCache = new Map();
async function preview(frame, opts = {}) {
  const key = `${frame.id}:${frame.mtime}:${today(opts.locale)}:${opts.title}:${opts.others ? opts.others.key : ''}`;
  if (previewCache.size > 100) previewCache.clear();
  if (!previewCache.has(key)) previewCache.set(key, render(frame, 1200, 800, opts).catch((e) => { previewCache.delete(key); throw e; }));
  return previewCache.get(key);
}

/**
 * Frame layers for one image size, for photo.process({ layers }). They are the same for
 * every shot of an event (same frame, title, date and camera resolution), so the last two
 * sets are kept: the screen size (fast version) and the full size. Only the
 * non-transparent parts are kept (see opaqueParts): a few tens of MB for a 24 Mpx camera,
 * depending on the frame.
 * @param {object} frame { id, mtime, file, title, locale }
 */
const overlayCache = new Map();
async function overlay(frame, width, height) {
  const key = [frame.id, frame.mtime, width, height, today(frame.locale), frame.title].join(':');
  if (!overlayCache.has(key)) {
    while (overlayCache.size >= 2) overlayCache.delete(overlayCache.keys().next().value); // free before rendering
    overlayCache.set(key, layers(frame, width, height, frame).catch((e) => { overlayCache.delete(key); throw e; }));
  }
  return overlayCache.get(key);
}

module.exports = {
  list, get, preview, overlay, FRAMES_DIR,
  // internals, exported for the unit tests
  fitTexts, opaqueParts, labelFromFile, today,
};
