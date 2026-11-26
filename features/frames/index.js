'use strict';

/**
 * Frames module: a frame (frames/ folder) laid over every photo, with the event title and
 * the date, and shown over live view on the tablet. Set up in /admin: frame, text.
 *
 *   index.js   settings, routes, journal entries, its edit of the photos
 *   render.js  the frame images: list, rendering, previews
 *   public/    the frame over live view (booth.js), the /admin card (admin.js), styles
 * See server/features.js for how modules plug in.
 */

const crypto = require('crypto');
const render = require('./render');

const MAX_TITLE = 60;
const SETTINGS = Object.freeze({
  frame: null, // id of the applied frame (null = no frame)
  frameTitle: process.env.FRAME_TITLE || 'Flash & Furious', // {{title}} text of every frame
});

module.exports = function frames(core) {
  const { settings, tr } = core;

  /** Frame name in the UI language (falls back to the SVG <title> or the file name). */
  function label(f) {
    const key = `frames.names.${f.id}`;
    return core.i18n.has(core.lang(), key) ? tr(key) : f.label;
  }
  /** Everything that changes how a frame looks: title, date language, other modules' layers. */
  async function options(conf) {
    return { title: conf.frameTitle, locale: core.i18n.t(conf.lang, 'locale'), others: await core.features.otherLayers(conf, 'frames') };
  }
  /** Preview URL; changes with the file and the options (browser cache busting). */
  async function previewUrl(f, conf) {
    const o = await options(conf);
    const t = crypto.createHash('md5').update(`${o.title}|${o.locale}|${o.others.key}`).digest('hex').slice(0, 8);
    return `/api/frames/${encodeURIComponent(f.id)}.png?v=${Math.round(f.mtime)}-${t}`;
  }

  function router() {
    const r = core.express.Router();

    r.get('/api/frames', async (_req, res) => {
      const conf = settings.get();
      const list = await render.list();
      res.json(await Promise.all(list.map(async (f) => ({ id: f.id, label: label(f), preview: await previewUrl(f, conf) }))));
    });

    r.get('/api/frames/:id.png', async (req, res) => {
      const frame = await render.get(req.params.id);
      if (!frame) return res.sendStatus(404);
      try {
        res.type('png').send(await render.preview(frame, await options(settings.get())));
      } catch (err) {
        console.error('[frame] preview:', err.message);
        res.sendStatus(500);
      }
    });

    return r;
  }

  return {
    settings: {
      defaults: SETTINGS,
      sanitize: (s) => ({
        frame: typeof s.frame === 'string' && /^[\w.-]+$/.test(s.frame) ? s.frame : null,
        frameTitle: typeof s.frameTitle === 'string' ? s.frameTitle.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : SETTINGS.frameTitle,
      }),
    },

    async settingsDto(conf) {
      const frame = await render.get(conf.frame).catch(() => null);
      // framesVersion: changes when the previews change (the admin card loads them again)
      const preview = frame ? await previewUrl(frame, conf) : null;
      const o = await options(conf);
      return {
        frame: frame ? { id: frame.id, label: label(frame), preview } : null,
        framesVersion: crypto.createHash('md5').update(`${o.title}|${o.locale}|${o.others.key}`).digest('hex').slice(0, 8),
      };
    },

    async settingsPatch(body) {
      const patch = {};
      if ('frameTitle' in body) patch.frameTitle = String(body.frameTitle ?? '');
      if ('frame' in body) {
        if (body.frame && !(await render.get(body.frame))) return { error: tr('frames.settings.unknownFrame') };
        patch.frame = body.frame || null;
      }
      return { patch };
    },

    async journalSettings(old, now, add) {
      if (now.frame !== old.frame) {
        const f = now.frame && (await render.get(now.frame).catch(() => null));
        if (f) add('frames.journal.settingFrame', { value: label(f) });
        else add('frames.journal.settingNoFrame');
      }
      if (now.frameTitle !== old.frameTitle) add('frames.journal.settingTitle', { value: now.frameTitle });
    },

    router,

    // the frame of a photo taken now, with its title and date language frozen (null: no frame)
    async forShot(conf) {
      if (!conf.frame) return null;
      const found = await render.get(conf.frame).catch(() => null);
      if (!found) return null;
      return { ...found, label: label(found), title: conf.frameTitle, locale: core.i18n.t(conf.lang, 'locale') };
    },
    // laid over the photo in its own colours, before the other layers (decorations)
    edit: { stage: 'layers', make: (frame) => (width, height) => render.overlay(frame, width, height) },
    order: 10,
    step: { icon: '🖼️', key: 'frames.booth.adding', priority: 40 },
    journalDetail: (frame) => ({ key: 'frames.journal.with', vars: { frame: frame.label } }),

    ui: { css: ['frames.css'], booth: ['booth.js'], admin: ['admin.js'] },
  };
};

module.exports.render = render; // for the tests
module.exports.MAX_TITLE = MAX_TITLE;
