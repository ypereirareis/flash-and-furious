'use strict';

/* Guest screen (tablet). Texts come from /locales/<lang>.json through t() (see i18n.js). */

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'), count: $('count'),
  shootBtn: $('shootBtn'), live: $('live'), review: $('review'), liveMsg: $('liveMsg'),
  lastThumb: $('lastThumb'),
  grid: $('grid'), empty: $('empty'),
  overlay: $('overlay'), countdown: $('countdown'), overlayText: $('overlayText'), overlayHint: $('overlayHint'), flash: $('flash'),
  viewer: $('viewer'), viewerImg: $('viewerImg'), viewerInfo: $('viewerInfo'),
  toast: $('toast'),
};

let photos = [];
let busy = false;
let cameraOk = false;
let cameraError = null; // shown in large on the shoot screen
let viewerIndex = -1;
let currentView = 'shoot';

// The DSLR's live view keeps the mirror up and the shutter open: the server starts it,
// only during a photo countdown when Live mode is enabled, and stops it on capture
// (or after 10 s at most).
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ---------- Views ---------- */
// The "Gallery" button is in the shoot column; "Back" only exists in the gallery
$('galleryBtn').addEventListener('click', () => showView('gallery'));
$('backBtn').addEventListener('click', () => showView('shoot'));
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  currentView = name;
  if (name === 'gallery') loadPhotos();
}

/* ---------- Live view (driven by the server) ---------- */
let liveOn = false; // is the stream shown right now?

// Called on server events
function showLive() {
  if (liveOn) return;
  liveOn = true;
  if (currentView !== 'shoot') showView('shoot');
  els.live.src = `/api/live.mjpeg?t=${Date.now()}`;
  els.live.hidden = false;
  els.review.hidden = true;
  renderLiveMsg();
}
function hideLive() {
  if (els.live.getAttribute('src') !== BLANK) els.live.src = BLANK; // closes the MJPEG connection
  liveOn = false;
  els.live.hidden = true;
  showLastFull();
  renderLiveMsg();
}
function renderLiveMsg() {
  renderStage();
  let text = !liveOn && els.review.hidden ? t('booth.tapToShoot') : '';
  if (cameraError && !busy) text = `⚠️ ${cameraError}`;
  els.liveMsg.textContent = text;
  els.liveMsg.hidden = !text;
}

/* ---------- Settings (set in /admin) ---------- */
let settings = { mirror: true, live: false };
// What the feature modules add to this screen (see features.js):
// { render?({ settings, stageFree }), shootOptions?() -> fields of the shot request }
const parts = window.BOOTH_PARTS;

function applySettings(next) {
  if (next.lang && next.lang !== I18N.lang) return location.reload(); // language changed in /admin
  settings = next;
  els.live.classList.toggle('mirrored', Boolean(settings.mirror));
  // ?theme=xxx in the address: preview a theme on this screen only (nothing is saved)
  const previewTheme = new URLSearchParams(location.search).get('theme');
  if (previewTheme || settings.theme) document.documentElement.dataset.theme = previewTheme || settings.theme;
  renderStage();
}
async function loadSettings() {
  try { applySettings(await fetch('/api/settings').then((r) => r.json())); } catch (_) { /* keep the defaults */ }
}

// What is laid over the stage: optional features (e.g. the frame over live view), and the
// "last photo" badge
function renderStage() {
  const stageFree = liveOn || els.review.hidden; // live view or the empty screen, not the last photo
  parts.forEach((p) => p.render && p.render({ settings, stageFree }));
  // the last photo (edited or not) is clearly labelled as such
  const badge = $('lastBadge');
  badge.hidden = els.review.hidden;
  if (!els.review.hidden && photos[0]) {
    const time = new Date(photos[0].date).toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit' });
    badge.textContent = t('booth.lastPhotoAt', { time });
  }
}

/* ---------- Status ---------- */
function renderStatus(text, kind) {
  els.status.className = `status ${kind || ''}`;
  els.statusText.textContent = text;
  els.shootBtn.disabled = busy || !cameraOk;
}

async function refreshStatus() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    busy = s.busy;
    cameraOk = (Boolean(s.camera) && !s.error) || s.busy;
    cameraError = s.busy ? null : (s.error || (s.camera ? null : t('status.noCamera')));
    if (s.busy) renderStatus(t('status.shooting'), 'busy');
    else if (cameraError) renderStatus(cameraError, 'err');
    else renderStatus(s.camera.model, 'ok');
    renderLiveMsg();
  } catch (_) {
    cameraOk = false;
    renderStatus(t('status.serverDown'), 'err');
  }
}

// No context menu ("Save image") on photos
document.addEventListener('contextmenu', (e) => { if (e.target.closest('img')) e.preventDefault(); });

/* ---------- Shooting ---------- */
els.shootBtn.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  els.shootBtn.disabled = true;
  try {
    const r = await fetch('/api/shoot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, ...parts.map((p) => (p.shootOptions ? p.shootOptions() : {})))),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('booth.cannotStart'));
  } catch (e) {
    busy = false;
    els.shootBtn.disabled = !cameraOk;
    toast(e.message);
  }
});

function showOverlay(num, text) {
  els.overlay.hidden = false;
  if (num !== '') clearWarning();
  els.overlay.classList.toggle('over-live', !els.live.hidden);
  if (num !== undefined) {
    els.countdown.textContent = num;
    els.countdown.classList.remove('tick');
    void els.countdown.offsetWidth;
    els.countdown.classList.add('tick');
  }
  els.overlayText.textContent = text || '';
}
// Messages before the countdown: "look" (camera icon, look at the lens) or "warning" (wait for the flash)
function showWarning(text, { look = false } = {}) {
  showOverlay('', '');
  els.overlay.classList.add('warning');
  els.overlay.classList.toggle('look', look);
  els.overlayText.hidden = look;
  els.overlayText.textContent = look ? '' : text || '';
  els.overlayHint.innerHTML = look
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span></span>`
    : '';
  if (look) els.overlayHint.querySelector('span').textContent = text || '';
  els.overlayHint.hidden = !look;
}
function clearWarning() {
  els.overlay.classList.remove('warning', 'look');
  els.overlayText.hidden = false;
  els.overlayHint.hidden = true;
}
function hideOverlay() {
  clearWarning();
  els.overlay.hidden = true;
  els.countdown.textContent = '';
}

function setLastThumb(photo) {
  els.lastThumb.hidden = false;
  els.lastThumb.querySelector('img').src = photo.thumb;
}

// When live view is off, the last photo is shown in large
function showLastFull() {
  if (liveOn || !photos[0]) { els.review.hidden = true; return; }
  els.review.src = photos[0].view;
  els.review.hidden = false;
}

/* ---------- Server events ---------- */
function startShooting() {
  busy = true;
  renderStatus(t('status.shooting'), 'busy');
  if (currentView !== 'shoot') showView('shoot');
  closeViewer();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    switch (ev.type) {
      case 'hello':
        busy = ev.busy;
        loadSettings(); // (re)connected: read the settings again
        if (ev.live === 'starting' || ev.live === 'on') showLive();
        refreshStatus();
        break;
      case 'countdown':
        startShooting();
        showOverlay(ev.remaining, t('booth.smile'));
        break;
      case 'phase':
        if (ev.phase === 'look' || ev.phase === 'warning') {
          startShooting();
          showWarning(ev.message, { look: ev.phase === 'look' });
        } else if (ev.phase === 'preparing') {
          startShooting();
          showOverlay('', t('booth.preparingLive'));
        } else if (ev.phase === 'focusing') showOverlay(undefined, t('booth.focusing'));
        else if (ev.phase === 'editing') showOverlay(ev.icon, ev.message); // photo being edited: message from the server
        else if (ev.phase === 'retrying') showOverlay('', t('booth.retrying'));
        else if (ev.phase === 'capturing') {
          hideLive(); // live view stops on capture
          showOverlay('📸', '');
          els.flash.classList.remove('on'); void els.flash.offsetWidth; els.flash.classList.add('on');
        } else if (ev.phase === 'idle') {
          busy = false;
          hideOverlay();
          refreshStatus();
        }
        break;
      case 'photo':
        photos = [ev.photo, ...photos.filter((p) => p.name !== ev.photo.name)];
        updateCount();
        renderGrid();
        setLastThumb(ev.photo);
        if (!liveOn) { showLastFull(); renderLiveMsg(); }
        break;
      case 'camera':
        if (!busy) refreshStatus();
        break;
      case 'settings':
        applySettings(ev.settings);
        break;
      case 'live':
        if (ev.state === 'starting' || ev.state === 'on') showLive();
        else if (busy && ev.state === 'off') liveOn = false; // keep the last frame frozen until capture
        else hideLive();
        if (ev.state === 'error' && ev.message) toast(ev.message);
        break;
      case 'error':
        hideOverlay();
        toast(ev.message);
        break;
    }
  };
  es.onerror = () => renderStatus(t('status.reconnecting'), 'err');
}

/* ---------- Gallery ---------- */
async function loadPhotos() {
  try {
    photos = await fetch('/api/photos').then((r) => r.json());
    updateCount();
    renderGrid();
  } catch (_) { /* ignore */ }
}
function updateCount() { els.count.textContent = photos.length ? `(${photos.length})` : ''; }

function renderGrid() {
  els.empty.hidden = photos.length > 0;
  const frag = document.createDocumentFragment();
  photos.forEach((p, i) => {
    const b = document.createElement('button');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.thumb;
    img.alt = p.name;
    b.appendChild(img);
    b.addEventListener('click', () => openViewer(i));
    frag.appendChild(b);
  });
  els.grid.replaceChildren(frag);
}

/* ---------- Viewer ---------- */
function openViewer(i) {
  if (i < 0 || i >= photos.length) return;
  viewerIndex = i;
  const p = photos[i];
  els.viewerImg.src = p.view;
  els.viewerInfo.textContent = `${new Date(p.date).toLocaleString(t('locale'))} · ${i + 1}/${photos.length}`;
  els.viewer.hidden = false;
}
function closeViewer() { els.viewer.hidden = true; viewerIndex = -1; }
const step = (d) => viewerIndex >= 0 && openViewer((viewerIndex + d + photos.length) % photos.length);

$('viewerClose').addEventListener('click', closeViewer);
$('viewerPrev').addEventListener('click', () => step(-1));
$('viewerNext').addEventListener('click', () => step(1));
document.addEventListener('keydown', (e) => {
  if (els.viewer.hidden) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
let touchX = null;
els.viewer.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
els.viewer.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  touchX = null;
});

/* ---------- Misc ---------- */
let toastTimer;
function toast(msg, kind) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('ok', kind === 'ok');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

$('fullscreenBtn').addEventListener('click', () => {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else {
    const el = d.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }
});

// Keeps the tablet from going to sleep while in use (when supported)
async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

/* ---------- Startup ---------- */
(async function init() {
  const initial = await loadSettingsLang(); // language first, so every text is translated
  await loadFeatures('booth');
  if (initial) applySettings(initial);
  refreshStatus(); // don't wait: the camera state arrives in parallel
  await loadPhotos();
  if (location.hash === '#gallery') showView('gallery');
  if (photos[0]) setLastThumb(photos[0]);
  connectEvents();
  hideLive();
  keepAwake();
  setInterval(() => { if (!busy) refreshStatus(); }, 10000);
})();
