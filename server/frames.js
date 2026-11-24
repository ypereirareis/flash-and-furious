'use strict';

/**
 * Frames: PNG (transparent) or SVG files from the frames/ folder.
 * In SVGs, {{title}} and {{date}} are replaced at render time.
 */

const path = require('path');
const fsp = require('fs').promises;
const sharp = require('sharp');

const FRAMES_DIR = path.resolve(process.env.FRAMES_DIR || path.join(__dirname, '..', 'frames'));
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

/** Renders a decoration SVG at the requested width (transparent PNG). */
async function renderDeco(file, width) {
  const svg = await fsp.readFile(file);
  const vb = String(svg).match(/viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"/);
  const svgWidth = vb ? Number(vb[1]) : 240;
  const density = Math.min(2400, Math.max(72, (72 * width) / svgWidth));
  return sharp(svg, { density }).resize({ width }).png().toBuffer({ resolveWithObject: true });
}

/**
 * Theme decorations placed on the image corners: bottom-left (~26 % of the width)
 * and top-left (~22 %), slightly inset from the edge.
 */
async function decoLayers(deco, width, height) {
  if (!deco) return [];
  const margin = Math.round(width * 0.012);
  const layers = [];
  if (deco.corner) {
    const { data, info } = await renderDeco(deco.corner, Math.round(width * 0.26));
    layers.push({ input: data, left: margin, top: Math.max(0, height - info.height - margin) });
  }
  if (deco.top) {
    const { data } = await renderDeco(deco.top, Math.round(width * 0.22));
    layers.push({ input: data, left: margin, top: margin });
  }
  return layers;
}

/**
 * Renders the frame as a transparent PNG of the requested size.
 * @param {object} opts { title: replaces {{title}}, locale: for {{date}}, deco: theme decorations (see themes.decoFiles) }
 */
async function render(frame, width, height, { title = '', locale, deco = null } = {}) {
  const base = await renderFrame(frame, width, height, title, today(locale));
  const layers = await decoLayers(deco, width, height);
  return layers.length ? sharp(base).composite(layers).png().toBuffer() : base;
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
    return sharp(Buffer.from(svg), { density }).resize(width, height, { fit: 'fill' }).png().toBuffer();
  }
  return sharp(frame.file).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

/** Lightweight preview (for the tablet and admin), cached in memory. */
const previewCache = new Map();
async function preview(frame, opts = {}) {
  const key = `${frame.id}:${frame.mtime}:${today(opts.locale)}:${opts.title}:${opts.deco ? opts.deco.id : ''}`;
  if (previewCache.size > 100) previewCache.clear();
  if (!previewCache.has(key)) previewCache.set(key, render(frame, 1200, 800, opts).catch((e) => { previewCache.delete(key); throw e; }));
  return previewCache.get(key);
}

/**
 * Processes the photo `src` and writes the result to `dst` (JPEG):
 *  - black & white if `bw` (the photo only: frame and decorations keep their colours);
 *  - frame (optional) with its text and the theme decorations: `frame` carries { title, locale, deco }.
 */
async function apply(frame, src, dst, { bw = false } = {}) {
  // apply the EXIF orientation first, to work on the image "the right way up"
  let img = sharp(src).rotate();
  if (bw) img = img.modulate({ saturation: 0 }).linear(1.08, -8); // B&W, slightly more contrast
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const layers = frame ? [{ input: await render(frame, info.width, info.height, frame) }] : [];
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .composite(layers)
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(dst);
}

module.exports = { list, get, preview, apply, FRAMES_DIR };
