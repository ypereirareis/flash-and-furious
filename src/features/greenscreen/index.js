'use strict';

/**
 * Green screen module: guests pose in front of a green cloth, and the green is replaced
 * with a background image (backgrounds/ folder). Set up in /admin: on/off, background,
 * calibration, tolerance.
 *
 *   index.js   settings, routes, journal entries, its edit of the photos
 *   images.js  backgrounds, calibration, previews, the green replaced on a photo
 *   key.js     the pixel work; worker.js runs it in a worker thread
 *   backgrounds/  the backgrounds (JPEG, PNG or SVG), editable without rebuilding the image
 *   public/    the /admin card
 * See server/features.js for how modules plug in.
 */

const path = require('path');
const fs = require('fs');
const images = require('./images');

const SETTINGS = Object.freeze({
  greenScreen: false, // replace the green cloth behind the guests with a background
  background: null, // id of the background (backgrounds/ folder)
  greenTolerance: 50, // 0-100: higher removes more green (50 = as calibrated)
  greenKey: null, // calibration { lo, hi, coverage, at } (null = default thresholds)
});

/** Calibration result, or null if missing or not usable. */
function validKey(k) {
  if (!k || typeof k !== 'object') return null;
  const n = (v) => Number.isFinite(v) && v >= 0 && v <= 255;
  if (!n(k.lo) || !n(k.hi) || k.lo >= k.hi) return null;
  return { lo: k.lo, hi: k.hi, coverage: Number.isFinite(k.coverage) ? k.coverage : null, at: Number.isFinite(k.at) ? k.at : null };
}

module.exports = function greenscreen(core) {
  const { settings, tr, journal } = core;
  // Small copy of the calibration photo: previews of the result in /admin
  const SAMPLE = path.join(settings.CONFIG_DIR, 'greenscreen-sample.jpg');

  function backgroundLabel(b) {
    const key = `greenscreen.backgrounds.${b.id}`;
    return core.i18n.has(core.lang(), key) ? tr(key) : b.label;
  }
  const thumbUrl = (b) => `/api/backgrounds/${encodeURIComponent(b.id)}.jpg?v=${Math.round(b.mtime)}`;

  /** The chosen background, or the first one when none is chosen yet (null if the folder is empty). */
  async function currentBackground(conf) {
    const chosen = await images.get(conf.background).catch(() => null);
    return chosen || (await images.list().catch(() => []))[0] || null;
  }
  /** Everything needed to replace the green of a photo, with these settings (null: no background). */
  async function greenOf(conf) {
    const bg = await currentBackground(conf);
    if (!bg) return null;
    return { background: { id: bg.id, label: backgroundLabel(bg), file: bg.file, mtime: bg.mtime }, key: conf.greenKey, tolerance: conf.greenTolerance };
  }

  function router() {
    const r = core.express.Router();

    r.get('/api/backgrounds', async (_req, res) => {
      const list = await images.list();
      res.json(list.map((b) => ({ id: b.id, label: backgroundLabel(b), preview: thumbUrl(b) })));
    });

    r.get('/api/backgrounds/:id.jpg', async (req, res) => {
      const bg = await images.get(req.params.id);
      if (!bg) return res.sendStatus(404);
      try {
        res.type('jpeg').send(await images.thumbnail(bg));
      } catch (err) {
        console.error('[green] background preview:', err.message);
        res.sendStatus(500);
      }
    });

    // The calibration photo with its green replaced by the current background and tolerance
    r.get('/api/greenscreen/preview.jpg', async (_req, res) => {
      const green = await greenOf(settings.get());
      if (!green || !fs.existsSync(SAMPLE)) return res.sendStatus(404);
      try {
        res.type('jpeg').send(await images.preview(SAMPLE, green));
      } catch (err) {
        console.error('[green] preview:', err.message);
        res.sendStatus(500);
      }
    });

    /**
     * Calibration: takes a photo of the green cloth (people may stand in front of it) and
     * measures its green. Not added to the gallery.
     */
    r.post('/api/greenscreen/calibrate', async (_req, res) => {
      const unavailable = core.cameraUnavailable();
      if (unavailable) return res.status(unavailable.status).json({ error: unavailable.error });
      const t = Date.now();
      const fail = (message, status) => Object.assign(new Error(message.key), { userMessage: message, status });
      try {
        const result = await core.captureAside('calibration', async (photo) => {
          if (!photo) throw fail({ key: 'greenscreen.noPhoto' });
          try {
            return await images.calibrate(photo, SAMPLE);
          } catch (err) {
            if (err.code !== 'notGreen') throw err;
            throw fail({ key: 'greenscreen.notGreen', vars: { coverage: Math.round(err.coverage * 100) } }, 422);
          }
        });
        core.chownSafe(SAMPLE);
        await settings.update({ greenKey: { ...result, at: Date.now() } }, core.chownSafe);
        console.log(`[green] calibrated in ${Date.now() - t} ms: ${JSON.stringify(result)}`);
        journal.add('success', 'settings', 'greenscreen.journal.calibrated', { coverage: result.coverage });
        res.json(await core.settingsChanged());
      } catch (err) {
        console.error('[green] calibration failed:', err.stderr || err.message);
        const m = err.userMessage || (err.textKey ? { camera: err.textKey } : { key: 'greenscreen.failed' });
        journal.add('error', 'settings', 'greenscreen.journal.calibrationFailed', { reason: m });
        res.status(err.status || 500).json({ error: core.translate(m) });
      }
    });

    return r;
  }

  return {
    settings: {
      defaults: SETTINGS,
      sanitize: (s) => ({
        greenScreen: Boolean(s.greenScreen),
        background: typeof s.background === 'string' && /^[\w.-]+$/.test(s.background) ? s.background : null,
        greenTolerance: Number.isFinite(Number(s.greenTolerance)) && s.greenTolerance !== null && s.greenTolerance !== ''
          ? Math.round(Math.min(100, Math.max(0, Number(s.greenTolerance))))
          : SETTINGS.greenTolerance,
        greenKey: validKey(s.greenKey),
      }),
    },

    async settingsDto(conf) {
      const bg = await currentBackground(conf);
      const key = conf.greenKey;
      return {
        background: bg ? { id: bg.id, label: backgroundLabel(bg), preview: thumbUrl(bg) } : null,
        greenKey: key ? { coverage: key.coverage, at: key.at } : null,
        // the calibration photo with the current background and tolerance
        greenPreview: fs.existsSync(SAMPLE) && bg
          ? `/api/greenscreen/preview.jpg?v=${[key && key.at, bg.id, Math.round(bg.mtime), conf.greenTolerance].join('-')}`
          : null,
      };
    },

    async settingsPatch(body) {
      const patch = {};
      if ('greenScreen' in body) patch.greenScreen = Boolean(body.greenScreen);
      if ('background' in body) {
        if (!(await images.get(body.background))) return { error: tr('greenscreen.settings.unknownBackground') };
        patch.background = body.background;
      }
      if ('greenTolerance' in body) {
        const n = Number(body.greenTolerance);
        if (!Number.isFinite(n) || n < 0 || n > 100) return { error: tr('greenscreen.settings.badTolerance') };
        patch.greenTolerance = Math.round(n);
      }
      return { patch };
    },

    async journalSettings(old, now, add) {
      if (now.greenScreen !== old.greenScreen) add(now.greenScreen ? 'greenscreen.journal.settingOn' : 'greenscreen.journal.settingOff');
      if (now.background !== old.background) {
        const b = await images.get(now.background).catch(() => null);
        if (b) add('greenscreen.journal.settingBackground', { value: backgroundLabel(b) });
      }
      if (now.greenTolerance !== old.greenTolerance) add('greenscreen.journal.settingTolerance', { value: now.greenTolerance });
    },

    router,

    // the background of a photo taken now (null: off), frozen with the photo
    forShot: (conf) => (conf.greenScreen ? greenOf(conf) : null),
    // first, in colour: black & white then applies to the background too
    edit: { stage: 'pixels', make: (green) => (img) => images.composite(img, green) },
    step: { icon: '🏝️', key: 'greenscreen.booth.applyingBackground', priority: 30 },
    journalDetail: (green) => ({ key: 'greenscreen.journal.with', vars: { background: green.background.label } }),

    ui: { css: ['admin.css'], admin: ['admin.js'] },
  };
};

module.exports.images = images; // for the tests
