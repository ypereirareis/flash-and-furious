'use strict';

/**
 * Photo storage checks (the host folder mounted on PHOTOS_DIR, see docker/entrypoint.sh).
 *
 * check() returns null when photos can be saved, otherwise the name of the problem:
 *   notMounted      the folder does not come from the host (photos would be lost with the container)
 *   externalMissing PHOTOS_EXTERNAL=true but the folder is on the same disk as the project
 *                   (external disk not plugged in / not mounted)
 *   notWritable     the folder cannot be written (read-only disk, disk unplugged, folder deleted...)
 *   full            less than STORAGE_MIN_FREE_MB left on the disk
 * The entrypoint's verdict is read once. The other checks run on every call, so that a disk
 * unplugged or a folder deleted during an event is detected:
 *  - cheap checks (folder still there, free space) for the periodic status;
 *  - plus a real write test ({ probe: true }) right before every photo, because a deleted folder
 *    or an unplugged disk can still look writable from its permissions alone.
 */

const fs = require('fs');
const path = require('path');

const STATUS_FILE = '/run/flash-and-furious/storage';
const EXTERNAL = process.env.PHOTOS_EXTERNAL === 'true';
const MIN_FREE = (Number(process.env.STORAGE_MIN_FREE_MB) || 200) * 1024 * 1024;
const PROBLEMS = ['notMounted', 'externalMissing', 'notWritable', 'full'];

let fromEntrypoint = null;
try {
  const code = fs.readFileSync(STATUS_FILE, 'utf8').trim();
  fromEntrypoint = PROBLEMS.includes(code) ? code : null;
} catch (_) {
  /* started without the entrypoint (development): runtime checks only */
}

function check(photosDir, configDir, { probe = false } = {}) {
  if (fromEntrypoint) return fromEntrypoint;
  try {
    const photos = fs.statSync(photosDir);
    // nlink 0: the folder was deleted (or its disk unmounted) on the host while mounted here
    if (!photos.isDirectory() || photos.nlink === 0) return 'notWritable';
    if (EXTERNAL && configDir && fs.existsSync(configDir) && photos.dev === fs.statSync(configDir).dev) return 'externalMissing';
    fs.accessSync(photosDir, fs.constants.W_OK);
    if (probe) {
      const file = path.join(photosDir, `.write-test.${process.pid}`);
      fs.writeFileSync(file, '');
      fs.unlinkSync(file);
    }
  } catch (_) {
    return 'notWritable';
  }
  try {
    const { bavail, bsize } = fs.statfsSync(photosDir);
    if (bavail * bsize < MIN_FREE) return 'full';
  } catch (_) {
    /* free space unknown: not blocking */
  }
  return null;
}

module.exports = { check, PROBLEMS };
