'use strict';

/**
 * Camera driver selection (CAMERA_DRIVER environment variable).
 *
 * ALL camera-specific code lives in this folder. The rest of the app only uses
 * the interface below; switching cameras = writing (or picking) a driver.
 *
 * Driver interface:
 *   id, label                     -> driver id and human-readable name
 *   info()                        -> { driver, label, capabilities }
 *       capabilities : { liveView, remoteAutofocus, focusMode }
 *   exclusive(fn)                 -> runs fn alone on the camera (queue)
 *   detect()                      -> [{ model, port }]
 *   autofocus()                   -> { ok, skipped?, error? }
 *   capture(dir, baseName)        -> writes dir/baseName.<ext>; returns the text output
 *   probe()                       -> { focusMode, raw }; throws if the camera does not respond
 *   getFocusMode()                -> { raw, mode: 'auto' | 'manual' | null }
 *   spawnLive()                   -> process writing consecutive JPEGs to stdout (stop: SIGINT)
 *   shouldRetryWithoutFile({ manual }) -> bool: shoot again if no photo arrived?
 *
 * Errors from gphoto2 carry `err.textKey`, the name of a user-facing text
 * ("camera.<name>" or "cameras.<driver id>.<name>" in public/locales/*.json).
 *
 * To add a camera: copy canon-eos-1000d.js, adapt it, then register it below.
 */

const DRIVERS = {
  'canon-eos-1000d': () => require('./canon-eos-1000d'),
  'gphoto2-generic': () => require('./gphoto2-generic'),
};

const DEFAULT_DRIVER = 'canon-eos-1000d';
const wanted = process.env.CAMERA_DRIVER || DEFAULT_DRIVER;

if (!DRIVERS[wanted]) {
  console.warn(`[camera] unknown driver "${wanted}" (available: ${Object.keys(DRIVERS).join(', ')}), using "${DEFAULT_DRIVER}".`);
}

module.exports = (DRIVERS[wanted] || DRIVERS[DEFAULT_DRIVER])();
