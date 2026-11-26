'use strict';

/**
 * Processing of a photo: the right way up, optional retouch (green screen), black & white,
 * layers composited over it (frame, theme decorations), JPEG.
 * Optional features plug in through `retouch` and `overlays`: this file knows none of them.
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
 * Processes the photo `src` and writes the result to `dst` (JPEG):
 *  - `retouch` (optional): async function changing the photo's RGB pixels before black &
 *    white, ({ data, info }) -> Buffer of the same size (the green screen uses it);
 *  - black & white if `bw` (the photo and its retouch; layers keep their colours);
 *  - `overlays`: async functions (width, height) -> sharp composite layers, laid over the
 *    photo in this order (frame, theme decorations).
 * `maxSize`: fast version for the screens, at most this many pixels on its longest side
 * (the full-size photo otherwise). `quality`: JPEG quality.
 */
async function process(src, dst, { retouch = null, bw = false, overlays = [], maxSize = null, quality = 92 } = {}) {
  // apply the EXIF orientation first, to work on the image "the right way up"
  let img = sharp(src).rotate();
  if (maxSize) img = img.resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true });
  if (retouch) {
    // in colour first; black & white then applies to the whole result
    const rgb = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    img = sharp(await retouch(rgb), { raw: rgb.info });
  }
  // B&W, slightly more contrast. greyscale() gives the same result as modulate({ saturation: 0 })
  // (within 2/255) about 7x faster; layers are composited in colour over it.
  if (bw) img = img.greyscale().linear(1.08, -8);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const layers = [];
  for (const overlay of overlays) layers.push(...(await overlay(info.width, info.height)));
  // plain libjpeg rather than mozjpeg: about twice as fast to encode at full size,
  // for files around a third larger at the same quality (a few hundred KB more)
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .composite(layers)
    .jpeg({ quality })
    .toFile(dst);
}

module.exports = { process, toRaw, rawLayer };
