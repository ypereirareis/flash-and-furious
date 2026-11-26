'use strict';

/**
 * Theme decorations module: the drawings of the colour theme (pumpkins, fir trees, cake…,
 * see server/themes.js) also placed on the corners of the photos, with or without a frame,
 * in colour even on black & white photos. On/off in /admin (Colour theme card).
 * The decorations of the screens themselves belong to the themes, not to this module.
 * See server/features.js for how modules plug in.
 */

const fsp = require('fs').promises;
const sharp = require('sharp');
const { toRaw, rawLayer } = require('../../server/photo');

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
 * (~22 %), slightly inset from the edge. Composite layers.
 * @param {object} deco { id, corner, top } (see themes.decoFiles)
 */
async function render(deco, width, height) {
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
 * The same for every shot of an event: the last sizes are kept (screen version, full size,
 * and the frame previews of /admin). Small: the drawings only cover part of the corners.
 */
const cache = new Map();
function layers(deco, width, height) {
  const key = [deco.id, width, height].join(':');
  if (!cache.has(key)) {
    while (cache.size >= 3) cache.delete(cache.keys().next().value);
    cache.set(key, render(deco, width, height).catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

module.exports = function decorations(core) {
  return {
    settings: {
      defaults: { photoDeco: false }, // also add the theme's decorations to the photos
      sanitize: (s) => ({ photoDeco: Boolean(s.photoDeco) }),
    },
    settingsDto: (conf) => ({ photoDeco: conf.photoDeco }),
    settingsPatch: (body) => ({ patch: 'photoDeco' in body ? { photoDeco: Boolean(body.photoDeco) } : {} }),
    journalSettings(old, now, add) {
      if (now.photoDeco !== old.photoDeco) add(now.photoDeco ? 'decorations.journal.settingOn' : 'decorations.journal.settingOff');
    },

    // the theme's decorations for a photo taken now (null: off, or a theme without any)
    forShot: (conf) => (conf.photoDeco ? core.themes.decoFiles(conf.theme) : null),
    // laid over the photo in their own colours, after the frame
    edit: { stage: 'layers', make: (deco) => (width, height) => layers(deco, width, height) },
    order: 20,
    step: { icon: '✨', key: 'decorations.booth.adding', priority: 10 },
    journalDetail: () => ({ key: 'decorations.journal.with' }),

    ui: { admin: ['admin.js'] },
  };
};
