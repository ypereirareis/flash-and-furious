'use strict';

/**
 * Frames, an optional feature: a frame (frames/ folder) laid over every photo, with the
 * event title and the date, and shown over live view on the tablet.
 *
 * Everything about it is in this folder:
 *   index.js   settings (frame, title), routes, journal entries, and the hooks used by the server;
 *   render.js  the frame images: list, rendering, previews.
 * Outside of it: public/frames/ (tablet overlay and admin card), the "frames" block of
 * public/locales/*.json, the frames/ folder, and a few lines marked "frames" in
 * server/index.js, public/index.html, public/admin.html, Dockerfile, docker-compose.yml
 * and scripts/smoke-test.sh.
 * The theme decorations on the photos do not depend on it (server/decorations.js).
 *
 * FRAMES=off disables it: no admin card, no routes, no frame on the tablet or the photos.
 * Its saved settings are kept for when it is switched back on.
 */

const crypto = require('crypto');
const express = require('express');
const settings = require('../settings');
const i18n = require('../i18n');
const decorations = require('../decorations');
const render = require('./render');

const ENABLED = !/^(off|0|false|no)$/i.test(String(process.env.FRAMES || '').trim());
const MAX_TITLE = 60;
const SETTINGS = Object.freeze({
  frame: null, // id of the applied frame (null = no frame)
  frameTitle: process.env.FRAME_TITLE || 'Flash & Furious', // {{title}} text of every frame
});

// Saved with the other settings (config/settings.json), even when the feature is off
settings.extend({
  defaults: SETTINGS,
  sanitize: (s) => ({
    frame: typeof s.frame === 'string' && /^[\w.-]+$/.test(s.frame) ? s.frame : null,
    frameTitle: typeof s.frameTitle === 'string' ? s.frameTitle.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : SETTINGS.frameTitle,
  }),
});

/* ---------- Translations: all under "frames." ---------- */
const lang = () => settings.get().lang;
const tr = (key, vars) => i18n.t(lang(), key, vars);
/** Frame name in the UI language (falls back to the SVG <title> or the file name). */
function label(f) {
  const key = `frames.names.${f.id}`;
  return i18n.has(lang(), key) ? tr(key) : f.label;
}

/** Everything that changes how a frame looks: title, date language, theme decorations. */
function options(conf) {
  return { title: conf.frameTitle, locale: i18n.t(conf.lang, 'locale'), deco: decorations.forPhoto(conf) };
}
/** Preview URL; changes with the file and the options (browser cache busting). */
function previewUrl(f, conf = settings.get()) {
  const o = options(conf);
  const t = crypto.createHash('md5').update(`${o.title}|${o.locale}|${o.deco ? o.deco.id : ''}`).digest('hex').slice(0, 8);
  return `/api/frames/${encodeURIComponent(f.id)}.png?v=${Math.round(f.mtime)}-${t}`;
}

/* ------------------------------------------------------------------ */
/* Hooks used by the server                                            */
/* ------------------------------------------------------------------ */

/**
 * Frame of a photo taken now, with its title and date language frozen at the time of the
 * shot (saved with the photo's job if it is processed later): null without a frame.
 */
async function forShot(conf = settings.get()) {
  if (!ENABLED || !conf.frame) return null;
  const found = await render.get(conf.frame).catch(() => null);
  if (!found) return null;
  const { title, locale } = options(conf);
  return { ...found, label: label(found), title, locale };
}

/** The frame layer, for photo.process({ overlays }), or null without a frame. */
function overlay(frame) {
  return frame ? (width, height) => render.overlay(frame, width, height) : null;
}

/** Message on the tablet while the photo is processed ({ icon, key }), or null. */
const step = (frame) => (frame ? { icon: '🖼️', key: 'frames.booth.adding' } : null);

/** Part of the journal entry of a photo ("“Party” frame"), or null. */
const journalDetail = (frame) => (frame ? { key: 'frames.journal.with', vars: { frame: frame.label } } : null);

/** Fields of the settings sent to the screens (none when off: no admin card, no overlay). */
async function settingsDto(conf = settings.get()) {
  if (!ENABLED) return Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, undefined]));
  const frame = await render.get(conf.frame).catch(() => null);
  return { frame: frame ? { id: frame.id, label: label(frame), preview: previewUrl(frame, conf) } : null };
}

/**
 * Frame settings sent to PUT /api/settings, checked.
 * @returns {Promise<{ patch: object } | { error: string }>} error translated
 */
async function settingsPatch(body) {
  const patch = {};
  if (!ENABLED) return { patch };
  if ('frameTitle' in body) patch.frameTitle = String(body.frameTitle ?? '');
  if ('frame' in body) {
    if (body.frame && !(await render.get(body.frame))) return { error: tr('frames.settings.unknownFrame') };
    patch.frame = body.frame || null;
  }
  return { patch };
}

/** Frame settings changed in /admin: journal entries, through add(key, vars). */
async function journalSettings(old, now, add) {
  if (now.frame !== old.frame) {
    const f = now.frame && (await render.get(now.frame).catch(() => null));
    if (f) add('frames.journal.settingFrame', { value: label(f) });
    else add('frames.journal.settingNoFrame');
  }
  if (now.frameTitle !== old.frameTitle) add('frames.journal.settingTitle', { value: now.frameTitle });
}

/** Routes: frame list and previews. Mounted only when the feature is on. */
function router() {
  const r = express.Router();

  r.get('/api/frames', async (_req, res) => {
    const list = await render.list();
    res.json(list.map((f) => ({ id: f.id, label: label(f), preview: previewUrl(f) })));
  });

  r.get('/api/frames/:id.png', async (req, res) => {
    const frame = await render.get(req.params.id);
    if (!frame) return res.sendStatus(404);
    try {
      res.type('png').send(await render.preview(frame, options(settings.get())));
    } catch (err) {
      console.error('[frame] preview:', err.message);
      res.sendStatus(500);
    }
  });

  return r;
}

module.exports = {
  ENABLED, MAX_TITLE, forShot, overlay, step, journalDetail, settingsDto, settingsPatch, journalSettings, router, render,
};
