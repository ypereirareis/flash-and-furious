'use strict';

/**
 * Photo storage checks (the host folder mounted on PHOTOS_DIR, see docker/entrypoint.sh).
 *
 * check() returns null when photos can be saved, otherwise the name of the problem:
 *   notMounted      the folder does not come from the host (photos would be lost with the container)
 *   externalMissing PHOTOS_EXTERNAL=true but the folder is on the same disk as the project
 *                   (external disk not plugged in / not mounted)
 *   notWritable     the folder cannot be written (read-only disk, disk unplugged...)
 * The entrypoint's verdict is read once; the cheap checks run again on every call, so that a disk
 * unplugged during an event is detected before the next photo.
 */

const fs = require('fs');

const STATUS_FILE = '/run/flash-and-furious/storage';
const EXTERNAL = process.env.PHOTOS_EXTERNAL === 'true';
const PROBLEMS = ['notMounted', 'externalMissing', 'notWritable'];

let fromEntrypoint = null;
try {
  const code = fs.readFileSync(STATUS_FILE, 'utf8').trim();
  fromEntrypoint = PROBLEMS.includes(code) ? code : null;
} catch (_) {
  /* started without the entrypoint (development): runtime checks only */
}

function check(photosDir, configDir) {
  if (fromEntrypoint) return fromEntrypoint;
  try {
    const photos = fs.statSync(photosDir);
    if (EXTERNAL && configDir && fs.existsSync(configDir) && photos.dev === fs.statSync(configDir).dev) return 'externalMissing';
    fs.accessSync(photosDir, fs.constants.W_OK);
    return null;
  } catch (_) {
    return 'notWritable';
  }
}

module.exports = { check };
