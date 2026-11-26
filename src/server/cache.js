'use strict';

/**
 * Cleaning of the photos cache (photos/.cache/), once at start-up, before any request.
 *
 * The cache holds copies of each photo (thumbnail, tablet and 4K versions). A photo deleted on
 * the host leaves its copies behind: they are no longer served, but they stay on the disk.
 *  - `<kind>_<photo>`: removed when the photo no longer exists, unless it is still being
 *    processed (`pending_<photo>.json`: its tablet copy stands in for it until then);
 *  - `*.tmp`: leftovers of a write cut short (stop, power cut): removed;
 *  - folders: temporary captures (e.g. green screen calibration) left by a cut: removed;
 *  - `pending_*.json` and anything else: kept.
 * A copy is only removed when its photo is really missing (ENOENT): on a read error (failing
 * disk...), it is kept.
 */
const fs = require('fs');
const path = require('path');

/** Is this file missing? false when it exists or cannot be checked. */
function missing(file) {
  try {
    fs.statSync(file);
    return false;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

/**
 * @param {string} cacheDir   photos/.cache
 * @param {string} photosDir  photos
 * @param {string[]} kinds    prefixes of the copies (thumb, view, tv)
 * @returns {{ removed: number, bytes: number }}
 */
function cleanCache(cacheDir, photosDir, kinds) {
  const result = { removed: 0, bytes: 0 };
  let entries;
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch (_) {
    return result; // no cache (yet), or storage problem: reported elsewhere
  }
  const copy = new RegExp(`^(${kinds.join('|')})_(.+)$`);
  for (const e of entries) {
    const file = path.join(cacheDir, e.name);
    let remove = false;
    if (e.isDirectory()) remove = true;
    else if (!e.isFile()) continue;
    else if (e.name.endsWith('.tmp')) remove = true;
    else {
      const m = e.name.match(copy);
      if (m) remove = missing(path.join(photosDir, m[2])) && missing(path.join(cacheDir, `pending_${m[2]}.json`));
    }
    if (!remove) continue;
    try {
      const size = e.isDirectory() ? 0 : fs.statSync(file).size;
      fs.rmSync(file, { recursive: true, force: true });
      result.removed += 1;
      result.bytes += size;
    } catch (err) {
      console.warn(`[cache] cannot remove ${e.name}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { cleanCache };
