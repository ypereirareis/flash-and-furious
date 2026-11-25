'use strict';

/**
 * Event journal shown in /admin: what happened during the event, in plain words
 * (photos, camera, storage, settings, start and stop). Not the technical log: the details
 * for troubleshooting stay in the Docker logs.
 *
 * Entries are saved to config/journal.jsonl (one JSON object per line), so they survive a
 * restart or a power cut. Messages are stored as a translation key with its values and
 * translated when read, in the current UI language.
 *
 * Entry: { id, at (ms), level, category, key, vars, detail }
 *   level     info | success | warning | error
 *   category  photo | camera | storage | settings | system
 *   vars      values of the {placeholders}; a value can itself be a message to translate
 *   detail    optional untranslated text shown under the message (e.g. a photo file name)
 *
 * The journal must never slow the booth down nor fill the disk:
 *  - add() only works in memory; the file is appended asynchronously, in batches;
 *  - at most MAX_ENTRIES entries and MAX_BYTES on disk: the file is rewritten with the
 *    newest entries when it grows past them (by 10 %, not on every entry);
 *  - texts are cut (MAX_TEXT characters), so an entry stays small (~300 bytes);
 *  - at most MAX_PER_MINUTE entries a minute: beyond, entries are counted, not written, and
 *    one entry says how many were skipped (a bug cannot flood the journal);
 *  - a write error (disk full, read-only) never reaches the caller: writing pauses for a
 *    minute, the journal goes on in memory;
 *  - at start-up, only the end of an oversized file is read.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LEVELS = ['info', 'success', 'warning', 'error'];
const CATEGORIES = ['photo', 'camera', 'storage', 'settings', 'system'];
const MAX_ENTRIES = Math.max(10, Number(process.env.JOURNAL_MAX_ENTRIES) || 5000);
const MAX_BYTES = Math.max(10 * 1024, Number(process.env.JOURNAL_MAX_BYTES) || 2 * 1024 * 1024);
const MAX_PER_MINUTE = Math.max(5, Number(process.env.JOURNAL_MAX_PER_MINUTE) || 120);
const MAX_TEXT = 200;
const FILE_NAME = `journal.jsonl`; // backquotes: not taken for a text key by check-i18n.js
const FLUSH_MS = 1000;
const PAUSE_AFTER_ERROR_MS = 60 * 1000;

let file = null;
let entries = [];
let nextId = 1;
let bytes = 0; // size of the file on disk
let lines = 0; // entries in the file on disk
let pending = []; // lines not written yet
let flushTimer = null;
let writing = Promise.resolve();
let pausedUntil = 0;
let minute = { start: 0, count: 0, skipped: 0 };
const listeners = new Set();

const cut = (v) => (typeof v === 'string' && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT - 1)}…` : v);
/** Values kept small: long texts cut, nested messages ({ key } / { camera }) kept as they are. */
function cleanVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {}).slice(0, 10)) {
    if (v && typeof v === 'object') out[k] = JSON.parse(JSON.stringify(v, (_k, x) => cut(x)));
    else out[k] = cut(typeof v === 'number' || typeof v === 'boolean' ? v : String(v ?? ''));
  }
  return out;
}

/** Reads the saved journal (lines that cannot be read are skipped). Synchronous: start-up only. */
function load(dir) {
  file = path.join(dir, FILE_NAME);
  entries = [];
  pending = [];
  bytes = 0;
  lines = 0;
  pausedUntil = 0;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r'); // size read on the open file, not on the path
    try {
      const size = fs.fstatSync(fd).size;
      // oversized file (should not happen): only its end is read
      const from = Math.max(0, size - MAX_BYTES);
      const buf = Buffer.alloc(size - from);
      const read = fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.subarray(0, read).toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1); // first line cut in the middle
      bytes = size;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* no journal yet */
  }
  const byId = new Map(); // an entry written twice (cut during a rewrite) is kept once
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    try {
      const e = JSON.parse(line);
      if (Number.isInteger(e.id) && typeof e.key === 'string') byId.set(e.id, e);
    } catch (_) {
      /* damaged line (e.g. power cut while writing): skipped */
    }
  }
  entries = [...byId.values()].sort((a, b) => a.id - b.id);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  nextId = entries.length ? entries[entries.length - 1].id + 1 : 1;
  if (bytes > MAX_BYTES || lines > MAX_ENTRIES) rewrite();
  return entries.length;
}

function push(entry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES * 1.1) entries = entries.slice(-MAX_ENTRIES);
  if (file) {
    pending.push(`${JSON.stringify(entry)}\n`);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (_) {
      /* a listener must not break the journal */
    }
  }
  return entry;
}

/** Adds an entry; returns it (or null when skipped). Never throws, never waits for the disk. */
function add(level, category, key, vars = {}, detail = null) {
  try {
    const now = Date.now();
    if (now - minute.start >= 60 * 1000) {
      const skipped = minute.skipped;
      minute = { start: now, count: 0, skipped: 0 };
      if (skipped) push(make('warning', 'system', 'journal.skipped', { count: skipped }, null, now));
    }
    if (minute.count >= MAX_PER_MINUTE) {
      minute.skipped += 1;
      return null;
    }
    minute.count += 1;
    return push(make(level, category, key, vars, detail, now));
  } catch (err) {
    console.error(`[journal] entry skipped: ${err.message}`);
    return null;
  }
}

function make(level, category, key, vars, detail, at) {
  return {
    id: nextId++,
    at,
    level: LEVELS.includes(level) ? level : 'info',
    category: CATEGORIES.includes(category) ? category : 'system',
    key: String(key),
    vars: cleanVars(vars),
    ...(detail ? { detail: cut(String(detail)) } : {}),
  };
}

/** Writes the waiting lines (one append for the whole batch), or rewrites a file grown too big. */
function flush() {
  flushTimer = null;
  if (!pending.length || !file) return writing;
  if (Date.now() < pausedUntil) {
    pending = []; // disk refused a write a moment ago: kept in memory only
    return writing;
  }
  const chunk = pending.join('');
  const count = pending.length;
  pending = [];
  writing = writing
    .then(async () => {
      // past the limits by 10 %: the file is rewritten with the newest entries (they include
      // this batch, already in memory), instead of growing
      if (bytes + Buffer.byteLength(chunk) > MAX_BYTES * 1.1 || lines + count > MAX_ENTRIES * 1.1) return rewriteAsync();
      await fsp.appendFile(file, chunk);
      bytes += Buffer.byteLength(chunk);
      lines += count;
    })
    .catch(onWriteError);
  return writing;
}

/** The newest entries that fit in MAX_ENTRIES and about 90 % of MAX_BYTES. */
function newest() {
  const out = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0 && out.length < MAX_ENTRIES; i--) {
    const line = `${JSON.stringify(entries[i])}\n`;
    if (size + Buffer.byteLength(line) > MAX_BYTES * 0.9) break;
    out.push(line);
    size += Buffer.byteLength(line);
  }
  entries = entries.slice(entries.length - out.length);
  return { text: out.reverse().join(''), size, count: out.length };
}

async function rewriteAsync() {
  const { text, size, count } = newest();
  const tmp = `${file}.tmp`;
  try {
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, file);
    bytes = size;
    lines = count;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function rewrite() {
  const { text, size, count } = newest();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    bytes = size;
    lines = count;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    onWriteError(err);
  }
}

function onWriteError(err) {
  if (Date.now() >= pausedUntil) console.error(`[journal] cannot write ${file}: ${err.message} (paused for a minute)`);
  pausedUntil = Date.now() + PAUSE_AFTER_ERROR_MS;
}

/**
 * One page of entries, newest first: those older than `before` (an id), at most `limit`.
 * @returns {{ entries: object[], more: boolean }}
 */
function page({ before = null, limit = 50 } = {}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  let end = entries.length;
  if (before !== null && before !== undefined && before !== '' && Number.isFinite(Number(before))) {
    // ids are sorted: first entry with id >= before (binary search)
    const id = Number(before);
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].id < id) lo = mid + 1;
      else hi = mid;
    }
    end = lo;
  }
  const start = Math.max(0, end - n);
  return { entries: entries.slice(start, end).reverse(), more: start > 0 };
}

/** Called with every new entry (live updates in /admin). */
function onAdd(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Writes what is waiting (clean stop). */
function close() {
  clearTimeout(flushTimer);
  return flush();
}

/** Last chance when the process exits (whatever the path): what is still waiting, synchronously. */
function flushSync() {
  clearTimeout(flushTimer);
  if (!pending.length || !file || Date.now() < pausedUntil) return;
  try {
    fs.appendFileSync(file, pending.join(''));
  } catch (_) {
    /* nothing more can be done */
  }
  pending = [];
}

module.exports = { load, add, page, onAdd, close, flushSync, LEVELS, CATEGORIES, MAX_ENTRIES, MAX_BYTES, MAX_PER_MINUTE, MAX_TEXT };
