'use strict';

/**
 * Feature modules: optional parts of the app that edit the photos or add settings, each in
 * its own folder of features/ (black & white, green screen, frames, theme decorations...).
 *
 * FEATURES (docker-compose.yml / .env) lists the active ones: "all" (default), "none", or
 * ids separated by commas, e.g. FEATURES=bw,frames. Removing a module = deleting its folder.
 * Settings in /admin stay as they are for the active modules (on/off, choices during the
 * event); the inactive ones are not loaded on the screens nor applied to the photos.
 *
 * A module folder:
 *   index.js        module.exports = (core) => definition (see below)
 *   locales/*.json  its texts, under a block named after the module ({ "frames": {...} })
 *   public/         files for the screens, served at /features/<id>/ when the module is active
 *   tests/unit/, tests/functional/
 *
 * Definition (every field is optional):
 *   settings: { defaults, sanitize(saved) -> values }   saved with the app settings (even
 *             when the module is inactive: they are kept for when it is switched back on)
 *   settingsDto(conf) -> fields sent to the screens (/admin, tablet)
 *   settingsPatch(body) -> { patch } | { error }         its fields of PUT /api/settings
 *   journalSettings(old, now, add)                      journal entries for its settings
 *   router() -> express router                          its routes
 *   forShot(conf, request) -> data | null               its edit of a photo taken now
 *             (request: body of POST /api/shoot); frozen with the photo, saved as JSON
 *   edit: { stage, make(data) -> step }                 its step of photo.process: stage
 *             'pixels', 'image' or 'layers' (in this order), step as photo.process expects it
 *   order: number                                       position among the steps of a stage
 *   step: { icon, key, priority }                       message on the tablet while editing
 *             (the module with the highest priority among the photo's edits is shown)
 *   journalDetail(data) -> message                      its part of the photo's journal entry
 *   ui: { css: [...], booth: [...], admin: [...] }      its files in public/ for each page (or its
 *             routes, starting with "/")
 *
 * core (given to every module): what the modules may use from the app, see server/index.js.
 */

const path = require('path');
const fs = require('fs');

// Folders holding modules: features/ (FEATURES_DIR: several folders separated by ":", e.g. to
// add the test modules of tests/functional/modules/)
const DIRS = (process.env.FEATURES_DIR || path.join(__dirname, '..', 'features')).split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
const STAGES = ['pixels', 'image', 'layers'];

/** Module folders present: [{ id, dir }], sorted by name. */
function present() {
  const found = [];
  for (const root of DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (_) {
      continue;
    }
    for (const id of names) {
      if (/^[\w-]+$/.test(id) && fs.existsSync(path.join(root, id, 'index.js')) && !found.some((m) => m.id === id)) found.push({ id, dir: path.join(root, id) });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** Ids asked for by FEATURES ("all" or unset: every module present, "none": none). */
function wanted(all) {
  const v = String(process.env.FEATURES ?? 'all').trim();
  if (v === 'all') return all;
  if (v === 'none') return [];
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of list) if (!all.includes(id)) console.warn(`[features] unknown module in FEATURES: ${id}`);
  return list.filter((id) => all.includes(id));
}

/** Texts of the modules for a language: merged into the app's (see i18n.js). */
function locales(lang) {
  const out = {};
  for (const { dir } of present()) {
    const file = path.join(dir, 'locales', `${lang}.json`);
    if (fs.existsSync(file)) Object.assign(out, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return out;
}

let modules = []; // every module present: { id, dir, active, def }

/**
 * Loads the modules: their settings are registered (all of them), the others hooks are used
 * for the active ones only. Called once, before the settings are loaded.
 */
function load(core) {
  const all = present();
  const on = new Set(wanted(all.map((m) => m.id)));
  modules = all.map(({ id, dir }) => {
    const def = require(path.join(dir, 'index.js'))(core) || {};
    if (def.settings) core.settings.extend(def.settings);
    return { id, dir, active: on.has(id), def };
  });
  console.log(`[features] active: ${active().map((m) => m.id).join(', ') || 'none'}`);
  return modules;
}

const active = () => modules.filter((m) => m.active);
/** Definition of an active module (undefined if it is off or missing). */
const get = (id) => (active().find((m) => m.id === id) || {}).def;
/** Active modules editing photos, in the order of their steps (stage, then order). */
const editors = () => {
  const rank = (m) => STAGES.findIndex((s) => m.def.edit && m.def.edit.stage === s);
  return active()
    .filter((m) => m.def.forShot && m.def.edit)
    .sort((a, b) => rank(a) - rank(b) || (a.def.order || 0) - (b.def.order || 0));
};

/** Setting keys of the inactive modules (not sent to the screens). */
function inactiveKeys() {
  return modules.filter((m) => !m.active && m.def.settings).flatMap((m) => Object.keys(m.def.settings.defaults));
}

/* ---------- Photos ---------- */

/** Edits of a photo taken now: { moduleId: data } for the modules that change it. */
async function forShot(conf, request = {}) {
  const edits = {};
  for (const m of editors()) {
    const data = await m.def.forShot(conf, request);
    if (data !== null && data !== undefined) edits[m.id] = data;
  }
  return edits;
}

/** Steps for photo.process, from a photo's edits (modules since switched off are skipped). */
function steps(edits) {
  const out = { pixels: [], image: [], layers: [] };
  for (const m of editors()) {
    if (!(m.id in edits)) continue;
    const s = m.def.edit.make(edits[m.id]);
    if (s) out[m.def.edit.stage].push(s);
  }
  return out;
}

/** Message on the tablet while a photo is edited: { icon, key } (or null). */
function step(edits) {
  const shown = editors().filter((m) => m.id in edits && m.def.step).sort((a, b) => b.def.step.priority - a.def.step.priority)[0];
  return shown ? shown.def.step : null;
}

/**
 * Details of the photo's journal entry: what is put on the photo first (background, frame,
 * decorations), then how it is rendered (black & white).
 */
function journalDetails(edits) {
  const last = (m) => (m.def.edit.stage === 'image' ? 1 : 0);
  return editors()
    .filter((m) => m.id in edits && m.def.journalDetail)
    .sort((a, b) => last(a) - last(b))
    .map((m) => m.def.journalDetail(edits[m.id]));
}

/**
 * Layers the other modules would add to a photo taken with these settings (e.g. the frame
 * previews show the theme decorations), and a key that changes with them.
 */
async function otherLayers(conf, exceptId) {
  const list = [];
  for (const m of editors()) {
    if (m.id === exceptId || m.def.edit.stage !== 'layers') continue;
    const data = await m.def.forShot(conf, {});
    if (data !== null && data !== undefined) list.push({ id: m.id, data, layers: m.def.edit.make(data) });
  }
  return {
    key: JSON.stringify(list.map((l) => [l.id, l.data])),
    render: async (width, height) => (await Promise.all(list.map((l) => l.layers(width, height)))).flat(),
  };
}

/* ---------- Settings ---------- */

async function settingsDto(conf) {
  const out = {};
  for (const m of active()) if (m.def.settingsDto) Object.assign(out, await m.def.settingsDto(conf));
  return out;
}

/** Fields of the active modules in a PUT /api/settings: { patch } or { error } (translated). */
async function settingsPatch(body) {
  const patch = {};
  for (const m of active()) {
    if (!m.def.settingsPatch) continue;
    const r = await m.def.settingsPatch(body);
    if (r.error) return { error: r.error };
    Object.assign(patch, r.patch);
  }
  return { patch };
}

async function journalSettings(old, now, add) {
  for (const m of active()) if (m.def.journalSettings) await m.def.journalSettings(old, now, add);
}

/* ---------- HTTP ---------- */

/** Routes and screen files of the active modules. */
function mount(app, express, staticOptions) {
  for (const m of active()) {
    if (m.def.router) app.use(m.def.router());
    const pub = path.join(m.dir, 'public');
    if (fs.existsSync(pub)) app.use(`/features/${m.id}`, express.static(pub, staticOptions));
  }
}

/** Files of the active modules for the screens: [{ id, css, booth, admin }] (URLs). */
function ui() {
  return active().map((m) => {
    const u = m.def.ui || {};
    // file of its public/ folder, or a route of the module (starting with "/")
    const urls = (list) => (list || []).map((f) => (f.startsWith('/') ? f : `/features/${m.id}/${f}`));
    return { id: m.id, css: urls(u.css), booth: urls(u.booth), admin: urls(u.admin) };
  });
}

module.exports = {
  DIRS, present, locales, load, active, get, inactiveKeys, forShot, steps, step, journalDetails, otherLayers,
  settingsDto, settingsPatch, journalSettings, mount, ui,
};
