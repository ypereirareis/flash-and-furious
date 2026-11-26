'use strict';

/**
 * Theme decorations module: drawings matching the colour theme (pumpkins, fir trees, cake…),
 * around the preview on the tablet and/or on the corners of the photos (with or without a
 * frame, in colour even on black & white photos). Two switches in /admin (Colour theme card).
 *
 * Decorations are optional for a theme, and found by its id: public/deco/<theme>-corner.svg
 * (bottom-left corner), <theme>-top.svg (top-left corner), <theme>-pattern.svg (pattern of the
 * control column). The themes themselves (server/themes.js) know nothing about them.
 * See server/features.js for how modules plug in.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');
const { toRaw, rawLayer } = require('../../server/photo');

const DECO_DIR = path.join(__dirname, 'public', 'deco');
const PARTS = ['corner', 'top', 'pattern'];

/** Decoration files of a theme: { id, corner, top, pattern } (paths or null), or null if none. */
function files(theme) {
  if (typeof theme !== 'string' || !/^[\w-]+$/.test(theme)) return null;
  const found = { id: theme };
  for (const part of PARTS) {
    const file = path.join(DECO_DIR, `${theme}-${part}.svg`);
    found[part] = fs.existsSync(file) ? file : null;
  }
  return PARTS.some((p) => found[p]) ? found : null;
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
 * (~22 %), slightly inset from the edge. Composite layers.
 * @param {object} deco { id, corner, top } (see files())
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
  /** Themes that have decorations (ids). */
  const decoThemes = () => core.themes.list().map((t) => t.id).filter((id) => files(id));

  /** Drawings of each theme for the screens, as CSS variables (see public/decorations.css). */
  function themesCss() {
    return decoThemes().map((id) => {
      const f = files(id);
      const vars = PARTS.filter((p) => f[p]).map((p) => `  --deco-${p}: url("/features/decorations/deco/${id}-${p}.svg");`);
      return `html[data-theme="${id}"] {\n${vars.join('\n')}\n}`;
    }).join('\n\n') + '\n';
  }

  function router() {
    const r = core.express.Router();
    r.get('/api/decorations/themes.css', (_req, res) => res.type('css').send(themesCss()));
    return r;
  }

  return {
    settings: {
      defaults: {
        screenDeco: true, // the theme's decorations around the preview on the tablet
        photoDeco: false, // the theme's decorations on the photos
      },
      sanitize: (s) => ({ screenDeco: s.screenDeco === undefined ? true : Boolean(s.screenDeco), photoDeco: Boolean(s.photoDeco) }),
    },
    settingsDto: (conf) => ({ screenDeco: conf.screenDeco, photoDeco: conf.photoDeco, decoThemes: decoThemes() }),
    settingsPatch(body) {
      const patch = {};
      if ('screenDeco' in body) patch.screenDeco = Boolean(body.screenDeco);
      if ('photoDeco' in body) patch.photoDeco = Boolean(body.photoDeco);
      return { patch };
    },
    journalSettings(old, now, add) {
      if (now.screenDeco !== old.screenDeco) add(now.screenDeco ? 'decorations.journal.screenOn' : 'decorations.journal.screenOff');
      if (now.photoDeco !== old.photoDeco) add(now.photoDeco ? 'decorations.journal.photosOn' : 'decorations.journal.photosOff');
    },

    router,

    // the theme's decorations for a photo taken now (null: off, or no corner drawing for this theme)
    forShot(conf) {
      const f = conf.photoDeco ? files(conf.theme) : null;
      return f && (f.corner || f.top) ? { id: f.id, corner: f.corner, top: f.top } : null;
    },
    // laid over the photo in their own colours, after the frame
    edit: { stage: 'layers', make: (deco) => (width, height) => layers(deco, width, height) },
    order: 20,
    step: { icon: '✨', key: 'decorations.booth.adding', priority: 10 },
    journalDetail: () => ({ key: 'decorations.journal.with' }),

    ui: { css: ['decorations.css', '/api/decorations/themes.css'], booth: ['booth.js'], admin: ['admin.js'] },
  };
};

module.exports.files = files; // for the tests
module.exports.DECO_DIR = DECO_DIR;
