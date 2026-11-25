'use strict';

// Worker thread of server/greenscreen.js: the per-pixel work, so that the server stays
// responsive meanwhile (countdown, live view, tablet). Buffers are shared, not copied.
const { parentPort } = require('worker_threads');
const { keyComposite } = require('./greenscreen-key');

parentPort.on('message', ({ id, photo, background, width, height, params }) => {
  try {
    keyComposite(new Uint8Array(photo), new Uint8Array(background), width, height, params);
    parentPort.postMessage({ id });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
