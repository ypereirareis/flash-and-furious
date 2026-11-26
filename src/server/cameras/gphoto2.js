'use strict';

/**
 * Common base for cameras driven by gphoto2 (most USB DSLRs and mirrorless cameras).
 *
 * A specific camera driver extends this class and only overrides what differs
 * (reading the focus mode, autofocus command, retry policy...).
 *
 * Safety principle: we NEVER CHANGE any persistent camera setting
 * (no firmware, no mode, no capture target, no ISO...).
 * The only commands sent are: detection and reads, a one-off focus action,
 * capture + download (with --keep: nothing is deleted), and reading the
 * electronic viewfinder for live view.
 *
 * Texts shown to users live in public/locales/*.json: generic ones under "camera",
 * driver-specific overrides under "cameras.<driver id>". Errors carry a text name in `err.textKey`.
 */

const { execFile, spawn } = require('child_process');

const GPHOTO = process.env.GPHOTO_BIN || 'gphoto2';

class Gphoto2Camera {
  /**
   * @param {object} opts
   * @param {string} opts.id             driver id (CAMERA_DRIVER)
   * @param {string} opts.label          human-readable name
   * @param {object} [opts.capabilities] { liveView, remoteAutofocus, focusMode }
   */
  constructor({ id, label, capabilities = {} }) {
    this.id = id;
    this.label = label;
    this.capabilities = { liveView: true, remoteAutofocus: true, focusMode: false, ...capabilities };
    this.chain = Promise.resolve();
    this.autofocusSupported = this.capabilities.remoteAutofocus;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /** gphoto2 does not support concurrent access: everything goes through this queue. */
  exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Runs gphoto2 with these arguments (outside the queue). */
  run(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      execFile(GPHOTO, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.textKey = this.explainError(`${stderr}\n${stdout}\n${err.message}`);
          return reject(err);
        }
        resolve(stdout);
      });
    });
  }

  /** Reads the current value of a setting (read-only). */
  async readConfig(name) {
    const out = await this.exclusive(() => this.run(['--get-config', name], 10000));
    const m = out.match(/Current:\s*(.+)/);
    return m ? m[1].trim() : '';
  }

  /** Name of the user-facing text that explains a gphoto2 error. */
  explainError(text) {
    if (/Could not claim the USB device|Could not lock the device/i.test(text)) return 'claimed';
    if (/No camera found|Could not detect any camera|-105/i.test(text)) return 'notDetected';
    if (/out of focus|Out of Focus|-110|busy/i.test(text)) return 'focusOrBusy';
    if (/ETIMEDOUT|timed out|SIGTERM/i.test(text)) return 'timeout';
    return 'generic';
  }

  /* ------------------------------------------------------------------ */
  /* Interface used by the rest of the app                               */
  /* ------------------------------------------------------------------ */

  /** Description for the UI (capabilities). */
  info() {
    return { driver: this.id, label: this.label, capabilities: { ...this.capabilities } };
  }

  /** Connected cameras: [{ model, port }] */
  async detect() {
    const out = await this.exclusive(() => this.run(['--auto-detect'], 15000));
    return out
      .split('\n')
      .slice(2) // "Model  Port" header + dashed line
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^(.*?)\s{2,}(usb:\S*)$/);
        return m ? { model: m[1].trim(), port: m[2] } : { model: l, port: '' };
      });
  }

  /**
   * One-off focus (same as a half-press): an action, not a setting.
   * @returns {{ok: boolean, skipped?: boolean, error?: string}} error = text name
   */
  async autofocus() {
    if (!this.autofocusSupported) return { ok: false, skipped: true };
    try {
      await this.exclusive(() => this.run(['--set-config', 'autofocusdrive=1'], 10000));
      return { ok: true };
    } catch (err) {
      const txt = `${err.stderr || ''}${err.stdout || ''}`;
      if (/not found in configuration tree|autofocusdrive.*not found/i.test(txt)) {
        this.autofocusSupported = false;
        console.warn(`[camera] remote autofocus not supported by ${this.label}, AF on capture.`);
        return { ok: false, skipped: true };
      }
      console.warn('[camera] autofocus failed:', txt.trim() || err.message);
      return { ok: false, error: err.textKey };
    }
  }

  /**
   * Takes a photo and copies the file(s) to `dir` as `baseName.<ext>`.
   * @returns {Promise<string>} text output (for logs)
   */
  capture(dir, baseName) {
    return this.exclusive(() =>
      this.run(['--capture-image-and-download', '--keep', '--force-overwrite', '--filename', `${dir}/${baseName}.%C`], 60000)
    );
  }

  /**
   * Checks that the camera really responds (not only that it is seen on USB).
   * Throws if it does not respond. Also returns the focus mode when it can be read.
   * @returns {Promise<{focusMode: 'auto'|'manual'|null, raw: string}>}
   */
  async probe() {
    await this.exclusive(() => this.run(['--summary'], 10000));
    return { focusMode: null, raw: '' };
  }

  /**
   * Current focus mode (read-only).
   * @returns {Promise<{raw: string, mode: 'auto'|'manual'|null}>} null = unknown
   */
  async getFocusMode() {
    return { raw: '', mode: null };
  }

  /**
   * Starts live view: a process that writes consecutive JPEG images to its stdout.
   * Must be started inside exclusive(). Stop it cleanly with SIGINT.
   */
  spawnLive() {
    return spawn(GPHOTO, ['--capture-movie', '--stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Should we refocus and shoot again when no photo arrived? */
  shouldRetryWithoutFile({ manual }) {
    return !manual && this.autofocusSupported;
  }
}

module.exports = { Gphoto2Camera };
