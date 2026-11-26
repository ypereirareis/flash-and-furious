'use strict';

/**
 * Fallback driver: any gphoto2-compatible camera.
 * Capture and live view (if the camera supports it); the focus mode is not read.
 * Starting point for writing a driver for a new camera (see canon-eos-1000d.js).
 */

const { Gphoto2Camera } = require('./gphoto2');

module.exports = new Gphoto2Camera({
  id: 'gphoto2-generic',
  label: 'Generic gphoto2 camera',
  capabilities: { liveView: true, remoteAutofocus: true, focusMode: false },
});
