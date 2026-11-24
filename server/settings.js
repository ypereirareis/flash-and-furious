'use strict';

/**
 * App settings, editable from /admin and saved to config/settings.json.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const themes = require('./themes');
const i18n = require('./i18n');

const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || path.join(__dirname, '..', 'config'));
const FILE = path.join(CONFIG_DIR, 'settings.json');
const ENV_LANG = process.env.DEFAULT_LANG;

const DEFAULTS = {
  mirror: true, // live view mirrored on the tablet
  live: false, // live view during the countdown
  frame: null, // id of the applied frame (null = no frame)
  frameTitle: process.env.FRAME_TITLE || 'Flash & Furious', // {{title}} text of every frame
  theme: themes.DEFAULT_THEME, // UI colour theme (see themes.js)
  frameDeco: false, // also add the theme's SVG decorations to framed photos
  lang: i18n.isValid(ENV_LANG) ? ENV_LANG : i18n.FALLBACK, // UI language (public/locales/)
};
const MAX_TITLE = 60;

// Ids used by earlier versions, mapped to the current ones
const LEGACY_FRAMES = { '02-fete': '02-party' };

let current = { ...DEFAULTS };

function load() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    current = sanitize({ ...DEFAULTS, ...saved });
  } catch (_) {
    current = { ...DEFAULTS };
  }
  return current;
}

function sanitize(s) {
  const frame = LEGACY_FRAMES[s.frame] || s.frame;
  const theme = themes.LEGACY_IDS[s.theme] || s.theme;
  return {
    mirror: Boolean(s.mirror),
    live: Boolean(s.live),
    frame: typeof frame === 'string' && /^[\w.-]+$/.test(frame) ? frame : null,
    frameTitle: typeof s.frameTitle === 'string' ? s.frameTitle.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : DEFAULTS.frameTitle,
    theme: themes.isValid(theme) ? theme : DEFAULTS.theme,
    frameDeco: Boolean(s.frameDeco),
    lang: i18n.isValid(s.lang) ? s.lang : DEFAULTS.lang,
  };
}

function get() {
  return { ...current };
}

/** Updates part of the settings and saves them. */
async function update(patch, chown) {
  const next = sanitize({ ...current, ...patch });
  const tmp = `${FILE}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fsp.rename(tmp, FILE);
  if (chown) chown(FILE);
  current = next;
  return get();
}

module.exports = { load, get, update, CONFIG_DIR, MAX_TITLE };
