'use strict';

/**
 * Processing of a photo: the right way up, the edits of the feature modules, JPEG.
 * This file knows none of the modules.
 */

const sharp = require('sharp');

/**
 * Uncompressed RGBA pixels, ready to be composited: encoding a full-size layer as PNG
 * only to decode it again right away costs seconds on a Raspberry Pi.
 */
const toRaw = (img) => img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const rawLayer = ({ data, info }, pos = {}) => ({
  input: data,
  raw: { width: info.width, height: info.height, channels: info.channels },
  ...pos,
});

/**
 * Processes the photo `src` and writes the result to `dst` (JPEG). The edits come from the
 * feature modules (see features.js), in three stages:
 *  - `pixels`: async functions changing the RGB pixels, ({ data, info }) -> Buffer of the
 *    same size (green screen);
 *  - `image`: functions adding sharp operations, (img) -> img (black & white);
 *  - `layers`: async functions (width, height) -> sharp composite layers, laid over the
 *    photo in this order, in their own colours (frame, theme decorations).
 * `maxSize`: fast version for the screens, at most this many pixels on its longest side
 * (the full-size photo otherwise). `quality`: JPEG quality.
 * The photo is decoded once, composited once and encoded once, whatever the edits.
 */
async function process(src, dst, { pixels = [], image = [], layers = [], maxSize = null, quality = 92 } = {}) {
  // apply the EXIF orientation first, to work on the image "the right way up"
  let img = sharp(src).rotate();
  if (maxSize) img = img.resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true });
  if (pixels.length) {
    const rgb = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const step of pixels) rgb.data = await step(rgb);
    img = sharp(rgb.data, { raw: rgb.info });
  }
  for (const step of image) img = step(img);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const over = [];
  for (const step of layers) over.push(...(await step(info.width, info.height)));
  // plain libjpeg rather than mozjpeg: about twice as fast to encode at full size,
  // for files around a third larger at the same quality (a few hundred KB more)
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .composite(over)
    .jpeg({ quality })
    .toFile(dst);
}

module.exports = { process, toRaw, rawLayer };
