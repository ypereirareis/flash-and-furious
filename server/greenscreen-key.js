'use strict';

/**
 * Green screen, pixel work (no dependencies: also runs in the worker thread).
 *
 * How green a pixel is: k = G - max(R, B). Skin, hair, most clothes: k <= 0. Green cloth:
 * k well above 0. Between two thresholds `lo` and `hi`, the pixel is partly background
 * (soft edges: hair, motion blur):
 *   k <= lo  person (opaque)
 *   k >= hi  background (replaced)
 * The thresholds come from a calibration photo of the cloth (see calibrate) and the
 * tolerance set in /admin.
 */

/** Thresholds used before any calibration: a typical, evenly lit green cloth. */
const DEFAULT_KEY = Object.freeze({ lo: 24, hi: 60 });
/** Less than this share of clearly green pixels in the calibration photo: no green cloth. */
const MIN_COVERAGE = 0.15;

/**
 * Thresholds from a photo showing the green cloth (people may be in front of it).
 * @param {Uint8Array} rgb pixels, 3 channels
 * @returns {{ lo: number, hi: number, coverage: number }} coverage in % of the photo
 * @throws {Error} with code 'notGreen' when the cloth is not found
 */
function calibrate(rgb, width, height) {
  const total = width * height;
  const values = [];
  for (let i = 0; i < total * 3; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const k = g - (r > b ? r : b);
    if (k > 25 && g > 50) values.push(k);
  }
  const coverage = values.length / total;
  if (coverage < MIN_COVERAGE) throw Object.assign(new Error('no green cloth found'), { code: 'notGreen', coverage });
  values.sort((a, b) => a - b);
  // the dimmest 20 % of the cloth (shadows, edges) is still fully replaced
  const hi = Math.max(30, Math.round(values[Math.floor(values.length * 0.2)] * 0.9));
  return { lo: Math.round(hi * 0.4), hi, coverage: Math.round(coverage * 100) };
}

/**
 * Thresholds for a photo: calibration (or default), adjusted by the tolerance (0-100, 50 =
 * as calibrated; higher removes more green), and the edge softening radius for this width.
 */
function params(key, tolerance = 50, width = 1920) {
  const k = key && Number.isFinite(key.lo) && Number.isFinite(key.hi) ? key : DEFAULT_KEY;
  const f = 1.5 - Math.min(100, Math.max(0, Number(tolerance))) / 100; // 1.5 .. 0.5
  const lo = Math.max(1, k.lo * f);
  return { lo, hi: Math.max(lo + 4, k.hi * f), radius: Math.max(1, Math.round(width / 1600)) };
}

/**
 * Replaces the green of `photo` with `background` (same size, RGB), in place in `photo`.
 * Green reflections on people (edges, skin) are removed; edges are softened over `radius` px.
 */
function keyComposite(photo, background, width, height, { lo, hi, radius = 1 }) {
  const n = width * height;
  const alpha = new Uint8Array(n); // share of background, 0-255
  const span = hi - lo;
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const r = photo[i];
    const g = photo[i + 1];
    const b = photo[i + 2];
    const m = r > b ? r : b;
    const k = g - m;
    if (k <= 0) continue;
    photo[i + 1] = m; // green reflection removed (kept colours: green no higher than red or blue)
    if (k >= hi) alpha[p] = 255;
    else if (k > lo) alpha[p] = ((k - lo) * 255) / span;
  }
  const soft = boxBlur(alpha, width, height, radius);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const a = soft[p];
    if (a === 0) continue;
    if (a === 255) {
      photo[i] = background[i];
      photo[i + 1] = background[i + 1];
      photo[i + 2] = background[i + 2];
    } else {
      const f = 255 - a;
      photo[i] = (photo[i] * f + background[i] * a + 127) / 255;
      photo[i + 1] = (photo[i + 1] * f + background[i + 1] * a + 127) / 255;
      photo[i + 2] = (photo[i + 2] * f + background[i + 2] * a + 127) / 255;
    }
  }
  return photo;
}

/**
 * Box blur of a one-channel image: horizontal running sums, then vertical ones kept per
 * column and moved down row by row (reading memory in order: several times faster than
 * walking down each column).
 */
function boxBlur(src, width, height, radius) {
  if (radius < 1) return src;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const size = radius * 2 + 1;
  const half = size >> 1;
  // integer division by size, (n * inv) >>> 16: same result as Math.floor(n / size) for these sums (unit tested)
  const inv = Math.ceil(65536 / size);
  const last = width - 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[row + (x < 0 ? 0 : x > last ? last : x)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = ((sum + half) * inv) >>> 16;
      const add = x + radius + 1;
      const sub = x - radius;
      sum += src[row + (add > last ? last : add)] - src[row + (sub < 0 ? 0 : sub)];
    }
  }
  const cols = new Uint32Array(width);
  for (let y = -radius; y <= radius; y++) {
    const row = (y < 0 ? 0 : y >= height ? height - 1 : y) * width;
    for (let x = 0; x < width; x++) cols[x] += tmp[row + x];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const addY = y + radius + 1;
    const subY = y - radius;
    const add = (addY >= height ? height - 1 : addY) * width;
    const sub = (subY < 0 ? 0 : subY) * width;
    for (let x = 0; x < width; x++) {
      out[row + x] = ((cols[x] + half) * inv) >>> 16;
      cols[x] += tmp[add + x] - tmp[sub + x];
    }
  }
  return out;
}

module.exports = { calibrate, params, keyComposite, boxBlur, DEFAULT_KEY, MIN_COVERAGE };
