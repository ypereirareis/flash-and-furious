'use strict';

/**
 * Driver: Canon EOS 1000D (and probably other Canon EOS bodies of the same generation).
 *
 * Specifics of this body:
 *  - AF/MF is selected with the physical switch on the lens; the gphoto2 setting
 *    "focusmode" then reads "Manual" (otherwise One Shot / AI Focus / AI Servo);
 *  - in One Shot AF, the body refuses to fire if it could not focus
 *    (often in low light, after the AF-assist flashes): we retry once;
 *  - live view only works in P/Tv/Av/M modes, with "Live View shooting" enabled;
 *  - no remote focus: the autofocusdrive command is accepted but ignored
 *    (tested with and without live view). AF happens on capture, or by hand (half-press).
 *
 * User-facing texts: "cameras.canon-eos-1000d" in public/locales/*.json.
 */

const { Gphoto2Camera } = require('./gphoto2');

class CanonEos1000D extends Gphoto2Camera {
  constructor() {
    super({
      id: 'canon-eos-1000d',
      label: 'Canon EOS 1000D',
      capabilities: { liveView: true, remoteAutofocus: false, focusMode: true },
    });
  }

  // Reading the focus mode doubles as the "does the camera respond?" check
  async probe() {
    const f = await this.getFocusMode();
    return { focusMode: f.mode, raw: f.raw };
  }

  // No remote AF, but the body refocuses on every capture:
  // if no photo arrived in AF (focus not found), try once more.
  shouldRetryWithoutFile({ manual }) {
    return !manual;
  }

  async getFocusMode() {
    const raw = await this.readConfig('focusmode');
    if (!raw) return { raw, mode: null };
    const auto = /one\s*shot|ai\s*focus|ai\s*servo/i.test(raw);
    return { raw, mode: auto ? 'auto' : 'manual' };
  }
}

module.exports = new CanonEos1000D();
