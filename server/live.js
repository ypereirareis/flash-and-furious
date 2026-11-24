'use strict';

/**
 * Live view streamed as MJPEG, driven by the server.
 *
 * On a DSLR, live view raises the mirror and keeps the shutter open:
 * it is therefore ONLY started during a photo countdown (when Live mode
 * is enabled in /admin), stopped right before focusing, and cut off in
 * any case after LIVE_MAX_SECONDS (10 s by default).
 *
 * The stream comes from the camera driver (camera.spawnLive()): consecutive JPEGs on stdout;
 * stopped with SIGINT, it must cleanly close the camera's live view.
 *
 * 'state' events: { state: 'off' | 'starting' | 'on' | 'error', textKey? } where textKey
 * names a user-facing camera text (see public/locales/*.json).
 */

const EventEmitter = require('events');
const sharp = require('sharp');
const camera = require('./cameras');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const BOUNDARY = 'flashandfuriousframe';
const MAX_BUFFER = 8 * 1024 * 1024;
// The camera sends lightly compressed JPEGs (~200 KB): we recompress them (~35 KB) for Wi-Fi.
const LIVE_QUALITY = Number(process.env.LIVE_QUALITY || 70);
const LIVE_MAX_MS = Number(process.env.LIVE_MAX_SECONDS || 10) * 1000;

class LiveView extends EventEmitter {
  constructor() {
    super();
    this.viewers = new Set();
    this.wanted = false; // should live view be running?
    this.proc = null;
    this.job = null; // current session (holds the camera lock)
    this.state = 'off';
    this.lastFrame = null;
    this.maxTimer = null;
  }

  get running() {
    return Boolean(this.job);
  }

  setState(state, extra = {}) {
    if (this.state === state && !extra.textKey) return;
    this.state = state;
    this.emit('state', { state, ...extra });
  }

  /** Starts live view (always limited to LIVE_MAX_MS). */
  start() {
    this.wanted = true;
    clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(() => {
      if (this.wanted) console.warn('[live] maximum duration reached, stopping live view');
      this.stop();
    }, LIVE_MAX_MS);
    this.ensure();
  }

  /** Waits for the first frame (or failure / timeout) before starting the countdown. */
  waitFirstFrame(timeoutMs) {
    if (this.state === 'on') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(t);
        this.off('frame', onFrame);
        this.off('state', onState);
        resolve(ok);
      };
      const onFrame = () => done(true);
      const onState = (s) => (s.state === 'off' || s.state === 'error') && done(false);
      const t = setTimeout(() => done(false), timeoutMs);
      this.on('frame', onFrame);
      this.on('state', onState);
    });
  }

  /** Stops live view and waits until the camera is released. */
  stop() {
    this.wanted = false;
    clearTimeout(this.maxTimer);
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGINT');
      const t1 = setTimeout(() => proc.exitCode === null && proc.kill('SIGTERM'), 4000);
      const t2 = setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 8000);
      proc.once('close', () => { clearTimeout(t1); clearTimeout(t2); });
    }
    for (const res of this.viewers) res.end();
    this.viewers.clear();
    this.lastFrame = null;
    if (!this.job) this.setState('off');
    return this.job || Promise.resolve();
  }

  /** Attaches an HTTP response as a viewer of the MJPEG stream. */
  addViewer(req, res) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });
    if (!this.wanted) return res.end(); // live view is not running: nothing to send
    this.viewers.add(res);
    if (this.lastFrame) this.writeFrame(res, this.lastFrame);
    req.on('close', () => this.viewers.delete(res));
  }

  ensure() {
    if (!this.wanted || this.job) return;
    this.setState('starting');
    this.job = camera
      .exclusive(() => this.session())
      .catch((err) => console.error('[live]', err.message))
      .finally(() => {
        this.job = null;
        this.proc = null;
        if (!this.wanted) return this.setState('off');
        // unexpected stop during a countdown: don't insist
        const textKey = this.noFrames ? 'liveUnavailable' : 'liveInterrupted';
        this.stop();
        this.setState('error', { textKey });
      });
  }

  session() {
    return new Promise((resolve) => {
      if (!this.wanted) return resolve(); // cancelled while waiting for the lock

      const proc = camera.spawnLive();
      this.proc = proc;
      let buf = Buffer.alloc(0);
      let stderr = '';
      let frames = 0;

      proc.stdout.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          const start = buf.indexOf(SOI);
          if (start < 0) { buf = Buffer.alloc(0); break; }
          const end = buf.indexOf(EOI, start + 2);
          if (end < 0) { if (start > 0) buf = buf.subarray(start); break; }
          frames += 1;
          this.onFrame(Buffer.from(buf.subarray(start, end + 2)));
          buf = buf.subarray(end + 2);
        }
        if (buf.length > MAX_BUFFER) buf = Buffer.alloc(0);
      });
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      proc.on('error', (err) => console.error('[live] spawn:', err.message));
      proc.on('close', (code, signal) => {
        this.noFrames = frames === 0;
        if (this.wanted) {
          console.warn(`[live] stream ended (code ${code}, signal ${signal}) ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        }
        resolve();
      });
    });
  }

  onFrame(raw) {
    if (this.encoding) return; // previous frame still being compressed: skip this one
    this.encoding = true;
    sharp(raw)
      .jpeg({ quality: LIVE_QUALITY })
      .toBuffer()
      .catch(() => raw)
      .then((frame) => {
        this.encoding = false;
        if (!this.wanted) return;
        this.lastFrame = frame;
        if (this.state !== 'on') this.setState('on');
        this.emit('frame');
        for (const res of this.viewers) {
          if (res.writableNeedDrain) continue; // slow client: skip the frame
          this.writeFrame(res, frame);
        }
      });
  }

  writeFrame(res, frame) {
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  }
}

module.exports = new LiveView();
