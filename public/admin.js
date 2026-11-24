'use strict';

/* Admin page. Texts come from /locales/<lang>.json through t() (see i18n.js). */

const $ = (id) => document.getElementById(id);
let settings = { mirror: true, live: false, frame: null };
let focusMode = null; // 'auto' | 'manual' | null, read from the camera
let focusWanted = null;
let busy = false;
// Capabilities and texts provided by the camera driver (server/cameras/)
let cam = { capabilities: { liveView: true, remoteAutofocus: true, focusMode: false }, texts: {} };

async function loadCameraInfo() {
  try { cam = await fetch('/api/camera').then((r) => r.json()); } catch (_) { /* defaults */ }
  $('liveRow').hidden = !cam.capabilities.liveView;
  $('focusCard').hidden = !cam.capabilities.focusMode;
  $('focusHint').textContent = cam.texts.focusModeHint || '';
}

/* ---------- Status ---------- */
function renderStatus(text, kind) {
  $('status').className = `status ${kind || ''}`;
  $('statusText').textContent = text;
}
async function refreshStatus(probe = false) {
  try {
    const s = await fetch(probe ? '/api/status?probe=1' : '/api/status').then((r) => r.json());
    busy = s.busy;
    if (s.busy) renderStatus(t('status.shooting'), 'busy');
    else if (s.error || !s.camera) renderStatus(s.error || t('status.noCamera'), 'err');
    else renderStatus(s.camera.model, 'ok');
    setFocusMode(s.focusMode);
  } catch (_) {
    renderStatus(t('status.serverDown'), 'err');
  }
}

/* ---------- Settings ---------- */
async function save(patch) {
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || t('admin.saveFailed'));
    applySettings(j);
    toast(t('admin.saved'), 'ok');
  } catch (err) {
    toast(err.message);
    loadSettings();
  }
}
function applySettings(s) {
  if (s.lang && s.lang !== I18N.lang) return location.reload(); // language changed: reload every text
  settings = s;
  $('liveToggle').checked = Boolean(s.live);
  $('mirrorToggle').checked = Boolean(s.mirror);
  $('decoToggle').checked = Boolean(s.frameDeco);
  // don't overwrite text being typed
  if (document.activeElement !== $('titleInput')) $('titleInput').value = s.frameTitle || '';
  if (s.theme) document.documentElement.dataset.theme = s.theme;
  renderFrames();
  renderThemes();
  renderLanguages();
}
async function loadSettings() {
  applySettings(await fetch('/api/settings').then((r) => r.json()));
}
$('liveToggle').addEventListener('change', (e) => save({ live: e.target.checked }));
$('mirrorToggle').addEventListener('change', (e) => save({ mirror: e.target.checked }));
$('decoToggle').addEventListener('change', async (e) => {
  await save({ frameDeco: e.target.checked });
  loadFrames(); // frame previews with or without decorations
});
$('titleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('titleInput').blur();
  await save({ frameTitle: $('titleInput').value });
  loadFrames(); // frame previews with the new text
});

/* ---------- Language ---------- */
let languages = [];
async function loadLanguages() {
  try { languages = await fetch('/api/languages').then((r) => r.json()); } catch (_) { languages = []; }
  renderLanguages();
}
function renderLanguages() {
  const buttons = languages.map((l) => {
    const b = Object.assign(document.createElement('button'), { textContent: l.label });
    b.classList.toggle('active', l.id === settings.lang);
    b.addEventListener('click', () => l.id !== settings.lang && save({ lang: l.id }));
    return b;
  });
  $('langSeg').replaceChildren(...buttons);
}

/* ---------- Address to type on the tablet ---------- */
async function loadNetwork() {
  let net;
  try { net = await fetch('/api/network').then((r) => r.json()); } catch (_) { return; }
  const [main, ...others] = net.addresses || [];
  if (!main) return;
  const bare = (url) => url.replace(/^http:\/\//, '');
  $('netUrl').textContent = bare(main.url);
  $('netMore').textContent = others.length ? t('admin.otherNetworks', { list: others.map((a) => bare(a.url)).join(' · ') }) : '';
  const link = (label, path) => Object.assign(document.createElement('a'), { href: main.url + path, textContent: `${label}: ${bare(main.url)}${path}`, target: '_blank', rel: 'noopener' });
  $('netLinks').replaceChildren(link(t('app.slideshow'), '/slideshow'), link(t('app.admin'), '/admin'));
  $('netQr').src = `/api/network/qr.svg?v=${encodeURIComponent(main.ip)}`;
  $('netBanner').hidden = false;
}

/* ---------- Themes ---------- */
let themeList = [];
async function loadThemes() {
  try { themeList = await fetch('/api/themes').then((r) => r.json()); } catch (_) { themeList = []; }
  renderThemes();
}
function renderThemes() {
  const tiles = themeList.map((th) => {
    const b = document.createElement('button');
    b.className = `theme-tile${settings.theme === th.id ? ' selected' : ''}`;
    b.dataset.theme = th.id; // the tile takes the theme's colours
    const sw = document.createElement('div');
    sw.className = 'theme-swatch';
    sw.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const cap = document.createElement('span');
    cap.textContent = th.label;
    b.append(sw, cap);
    b.addEventListener('click', async () => {
      await save({ theme: th.id });
      if (settings.frameDeco) loadFrames(); // preview decorations change with the theme
    });
    return b;
  });
  $('themeGrid').replaceChildren(...tiles);
  // explanation depending on the chosen theme and frame
  const cur = themeList.find((th) => th.id === settings.theme);
  let hint = t('admin.decoHint');
  if (cur && !cur.hasDeco) hint += t('admin.decoNone', { theme: cur.label });
  else if (!settings.frame) hint += t('admin.decoNoFrame');
  $('decoHint').textContent = hint;
}

/* ---------- Frames ---------- */
let frameList = [];
async function loadFrames() {
  try { frameList = await fetch('/api/frames').then((r) => r.json()); } catch (_) { frameList = []; }
  renderFrames();
}
function tile(label, previewUrl, selected, onPick) {
  const b = document.createElement('button');
  b.className = `frame-tile${selected ? ' selected' : ''}`;
  const box = document.createElement('div');
  box.className = 'frame-thumb';
  if (previewUrl) {
    const img = document.createElement('img');
    img.src = previewUrl;
    img.alt = '';
    box.appendChild(img);
  } else {
    box.classList.add('none');
    box.dataset.label = t('admin.photoOnly');
  }
  const cap = document.createElement('span');
  cap.textContent = label;
  b.append(box, cap);
  b.addEventListener('click', onPick);
  return b;
}
function renderFrames() {
  const cur = settings.frame ? settings.frame.id : null;
  const tiles = [tile(t('admin.noFrame'), null, !cur, () => save({ frame: null }))];
  frameList.forEach((f) => tiles.push(tile(f.label, f.preview, cur === f.id, () => save({ frame: f.id }))));
  $('frameGrid').replaceChildren(...tiles);
}

/* ---------- Focus (mode read from the camera) ---------- */
function setFocusMode(mode) {
  const changed = mode !== focusMode;
  focusMode = mode;
  $('focusSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.focus === mode));
  if (focusWanted && mode === focusWanted) {
    closeFocusHelp();
    if (changed) toast(t(mode === 'manual' ? 'admin.manualOn' : 'admin.autoOn'), 'ok');
  }
}
function openFocusHelp(target) {
  focusWanted = target;
  const toManual = target === 'manual';
  $('focusTitle').textContent = t(toManual ? 'admin.toManualTitle' : 'admin.toAutoTitle');
  const steps = (toManual ? cam.texts.toManualSteps : cam.texts.toAutoSteps) || [];
  $('focusSteps').replaceChildren(...steps.map((s) => Object.assign(document.createElement('li'), { textContent: s })));
  $('focusNowBtn').hidden = !toManual || !cam.capabilities.remoteAutofocus;
  $('focusHelp').hidden = false;
}
function closeFocusHelp() {
  focusWanted = null;
  $('focusHelp').hidden = true;
}
$('focusSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-focus]');
  if (!b) return;
  if (!focusMode) return toast(t('admin.focusUnknown'));
  if (b.dataset.focus === focusMode) return closeFocusHelp();
  openFocusHelp(b.dataset.focus);
});
$('focusCancel').addEventListener('click', closeFocusHelp);
$('focusNowBtn').addEventListener('click', async () => {
  const btn = $('focusNowBtn');
  const lbl = btn.querySelector('.lbl');
  btn.disabled = true;
  lbl.textContent = t('admin.focusing');
  try {
    const r = await fetch('/api/focus', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || t('admin.focusFailed'));
    toast(cam.texts.focusDone, 'ok');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    lbl.textContent = t('admin.focusNow');
  }
});

/* ---------- Server events ---------- */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'settings') applySettings(ev.settings);
    else if (ev.type === 'focusMode') setFocusMode(ev.mode);
    else if (ev.type === 'camera') refreshStatus();
    else if (ev.type === 'phase') {
      busy = ev.phase !== 'idle';
      if (busy) renderStatus(t('status.shooting'), 'busy');
      else refreshStatus();
    } else if (ev.type === 'hello') refreshStatus();
  };
  es.onerror = () => renderStatus(t('status.reconnecting'), 'err');
}

/* ---------- Misc ---------- */
let toastTimer;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('ok', kind === 'ok');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

(async function init() {
  const initial = await loadSettingsLang(); // language first, so every text is translated
  refreshStatus();
  loadNetwork();
  await Promise.all([loadCameraInfo(), loadFrames(), loadThemes(), loadLanguages()]);
  if (initial) applySettings(initial);
  else loadSettings().catch(() => {});
  connectEvents();
  // camera monitoring: more frequent while the focus mode is being changed
  setInterval(() => { if (!busy) refreshStatus(); }, 10000);
  setInterval(() => { if (focusWanted && !busy) refreshStatus(true); }, 2000);
})();
