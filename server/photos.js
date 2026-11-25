'use strict';

/**
 * Pure helpers about photos and the network, without side effects (unit-tested).
 */

const path = require('path');
const os = require('os');

/** Files shown as photos: JPEG only (a RAW file stays next to its JPEG). */
const IMAGE_RE = /\.(jpe?g)$/i;

/** Photo file name from a request, or null if it is not one (no path, no hidden file). */
function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!IMAGE_RE.test(base) || base.startsWith('.')) return null;
  return base;
}

/** Date and time of a photo, for its file name: 20261125_074116_022 */
function timestamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
}

/** Photo as sent to the screens; the version in the URLs changes with the file (browser cache). */
function toDto(p) {
  const v = Math.round(p.mtime);
  const name = encodeURIComponent(p.name);
  return {
    name: p.name,
    date: new Date(p.mtime).toISOString(),
    thumb: `/media/thumb/${name}?v=${v}`,
    view: `/media/view/${name}?v=${v}`,
    tv: `/media/tv/${name}?v=${v}`,
  };
}

/**
 * Private IPv4 addresses of the host (Wi-Fi / Ethernet), excluding Docker's internal interfaces,
 * Wi-Fi first. `forced` (HOST_IP) replaces the detection when it is wrong.
 */
function lanAddresses(interfaces = os.networkInterfaces(), forced = process.env.HOST_IP) {
  const ip = (forced || '').trim();
  if (ip) return [{ ip, iface: 'HOST_IP' }];
  const out = [];
  for (const [iface, list] of Object.entries(interfaces)) {
    if (/^(docker|br-|veth|virbr|lo)/.test(iface)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue; // private addresses
      out.push({ ip: a.address, iface });
    }
  }
  return out.sort((x, y) => Number(/^w/.test(y.iface)) - Number(/^w/.test(x.iface)));
}

module.exports = { IMAGE_RE, safeName, timestamp, toDto, lanAddresses };
