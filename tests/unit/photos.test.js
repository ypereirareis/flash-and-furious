'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeName, timestamp, toDto, lanAddresses, IMAGE_RE } = require('../../server/photos');

test('safeName keeps photo file names only', () => {
  assert.equal(safeName('flash-and-furious_20261125_074116_022.jpg'), 'flash-and-furious_20261125_074116_022.jpg');
  assert.equal(safeName('PHOTO.JPEG'), 'PHOTO.JPEG');
  // no way out of the photos folder
  assert.equal(safeName('../../etc/passwd.jpg'), 'passwd.jpg');
  assert.equal(safeName('/abs/path/x.jpg'), 'x.jpg');
  // hidden files (temporary full-size versions) and other types are refused
  assert.equal(safeName('.flash.jpg.tmp'), null);
  assert.equal(safeName('.hidden.jpg'), null);
  assert.equal(safeName('photo.cr2'), null);
  assert.equal(safeName('photo.png'), null);
  assert.equal(safeName(''), null);
  assert.equal(safeName(undefined), null);
});

test('IMAGE_RE matches JPEG files only', () => {
  assert.ok(IMAGE_RE.test('a.jpg') && IMAGE_RE.test('a.JPG') && IMAGE_RE.test('a.jpeg'));
  assert.ok(!IMAGE_RE.test('a.jpg.tmp') && !IMAGE_RE.test('a.cr2'));
});

test('timestamp: sortable date and time with milliseconds', () => {
  assert.equal(timestamp(new Date(2026, 0, 5, 7, 4, 9, 22)), '20260105_070409_022');
  assert.match(timestamp(), /^\d{8}_\d{6}_\d{3}$/);
});

test('toDto: URLs encoded and versioned by the file time', () => {
  const mtime = Date.UTC(2026, 10, 25, 7, 41, 16, 22);
  const dto = toDto({ name: 'a b#c.jpg', mtime: mtime + 0.4 });
  assert.equal(dto.name, 'a b#c.jpg');
  assert.equal(dto.date, '2026-11-25T07:41:16.022Z');
  assert.equal(dto.thumb, `/media/thumb/a%20b%23c.jpg?v=${mtime}`);
  assert.equal(dto.view, `/media/view/a%20b%23c.jpg?v=${mtime}`);
  assert.equal(dto.tv, `/media/tv/a%20b%23c.jpg?v=${mtime}`);
});

test('lanAddresses: private IPv4 only, Docker interfaces left out, Wi-Fi first', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'br-1234': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    veth9: [{ family: 'IPv4', address: '10.0.0.9', internal: false }],
    enp3s0: [
      { family: 'IPv4', address: '192.168.1.10', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    wlp2s0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    ppp0: [{ family: 'IPv4', address: '8.8.8.8', internal: false }], // public: left out
    tun0: [{ family: 'IPv4', address: '172.32.0.1', internal: false }], // outside 172.16/12
  };
  assert.deepEqual(lanAddresses(ifaces, ''), [
    { ip: '192.168.1.20', iface: 'wlp2s0' },
    { ip: '192.168.1.10', iface: 'enp3s0' },
  ]);
});

test('lanAddresses: HOST_IP replaces the detection', () => {
  assert.deepEqual(lanAddresses({}, ' 192.168.0.42 '), [{ ip: '192.168.0.42', iface: 'HOST_IP' }]);
  assert.deepEqual(lanAddresses({}, ''), []);
});
