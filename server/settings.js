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
  theme: themes.DEFAULT_THEME, // UI colour theme (see themes.js)
  photoDeco: false, // also add the theme's SVG decorations to the photos
  lang: i18n.isValid(ENV_LANG) ? ENV_LANG : i18n.FALLBACK, // UI language (public/locales/)
};
/**
 * Settings added by an optional feature (e.g. the green screen): its defaults, and a
 * function cleaning up its values. Saved in the same file.
 */
const extensions = [];
function extend({ defaults, sanitize: clean }) {
  extensions.push({ defaults, clean });
  current = { ...defaults, ...current };
}

let current = { ...DEFAULTS };

function load() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    current = sanitize({ ...allDefaults(), ...saved });
  } catch (_) {
    current = allDefaults();
  }
  return current;
}

const allDefaults = () => Object.assign({ ...DEFAULTS }, ...extensions.map((e) => e.defaults));

function sanitize(s) {
  const base = {
    mirror: Boolean(s.mirror),
    live: Boolean(s.live),
    theme: themes.isValid(s.theme) ? s.theme : DEFAULTS.theme,
    photoDeco: Boolean(s.photoDeco),
    lang: i18n.isValid(s.lang) ? s.lang : DEFAULTS.lang,
  };
  return Object.assign(base, ...extensions.map((e) => e.clean(s)));
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

module.exports = { load, get, update, extend, CONFIG_DIR };
