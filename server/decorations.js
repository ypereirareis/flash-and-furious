'use strict';

/**
 * Theme decorations on the photos (/admin option): the theme's drawings (see themes.decoFiles)
 * placed on the image corners, with or without a frame.
 */

const fsp = require('fs').promises;
const sharp = require('sharp');
const themes = require('./themes');
const { toRaw, rawLayer } = require('./photo');

/** Decorations to add to a photo taken with these settings, or null. { id, corner, top } */
function forPhoto(conf) {
  return conf.photoDeco ? themes.decoFiles(conf.theme) : null;
}

/** Renders a decoration SVG at the requested width (raw RGBA). */
async function renderDeco(file, width) {
  const svg = await fsp.readFile(file);
  const vb = String(svg).match(/viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"/);
  const svgWidth = vb ? Number(vb[1]) : 240;
  const density = Math.min(2400, Math.max(72, (72 * width) / svgWidth));
  return toRaw(sharp(svg, { density }).resize({ width }));
}

/**
 * Decorations placed on the image corners: bottom-left (~26 % of the width) and top-left
 * (~22 %), slightly inset from the edge. Composite layers (not cached: see layers()).
 */
async function render(deco, width, height) {
  if (!deco) return [];
  const margin = Math.round(width * 0.012);
  const out = [];
  if (deco.corner) {
    const img = await renderDeco(deco.corner, Math.round(width * 0.26));
    out.push(rawLayer(img, { left: margin, top: Math.max(0, height - img.info.height - margin) }));
  }
  if (deco.top) {
    out.push(rawLayer(await renderDeco(deco.top, Math.round(width * 0.22)), { left: margin, top: margin }));
  }
  return out;
}

/**
 * The same for every shot of an event: the last two sizes are kept (screen version and
 * full size). Small: the drawings only cover part of the corners.
 */
const cache = new Map();
function layers(deco, width, height) {
  if (!deco) return Promise.resolve([]);
  const key = [deco.id, width, height].join(':');
  if (!cache.has(key)) {
    while (cache.size >= 2) cache.delete(cache.keys().next().value);
    cache.set(key, render(deco, width, height).catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

/** Overlay for photo.process({ overlays }), or null without decorations. */
const overlay = (deco) => (deco ? (width, height) => layers(deco, width, height) : null);

module.exports = { forPhoto, layers, overlay, render };
