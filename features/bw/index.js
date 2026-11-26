'use strict';

/**
 * Black & white module: a button on the tablet lets the guests choose black & white photos
 * (remembered on the tablet, live view shown in black & white too). The photo and its
 * background turn grey; the frame and decorations keep their colours.
 * See server/features.js for how modules plug in.
 */

// B&W, slightly more contrast. greyscale() gives the same result as modulate({ saturation: 0 })
// (within 2/255) about 7x faster.
const greyscale = (img) => img.greyscale().linear(1.08, -8);

module.exports = function bw() {
  return {
    // chosen by the guests on the tablet: { bw: true } in the shot request
    forShot: (_conf, request) => (request && request.bw ? true : null),
    // after the green screen (its background turns grey too), before the layers (in colour)
    edit: { stage: 'image', make: () => greyscale },
    step: { icon: '🎞️', key: 'bw.applying', priority: 20 },
    journalDetail: () => ({ key: 'bw.journal.with' }),

    ui: { css: ['bw.css'], booth: ['booth.js'] },
  };
};
