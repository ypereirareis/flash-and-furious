'use strict';

/*
 * Green screen card of the admin page (optional feature, see server/greenscreen/index.js).
 * Loaded before admin.js and registered in ADMIN_PARTS: admin.js calls load() at start and
 * render(settings) on every settings change, and provides save(), tile(), toast() and
 * applySettings(). The card stays hidden when the server has the feature off.
 */
(function greenScreenCard() {
  const card = document.createElement('section');
  card.className = 'card wide';
  card.id = 'greenCard';
  card.hidden = true;
  // static markup, texts filled by applyI18n()
  card.innerHTML = `
    <h2 data-i18n="greenscreen.admin.title"></h2>
    <p class="hint" data-i18n="greenscreen.admin.hint"></p>
    <label class="switch-row">
      <span>
        <strong data-i18n="greenscreen.admin.toggle"></strong>
        <small data-i18n="greenscreen.admin.toggleHint"></small>
      </span>
      <input type="checkbox" id="greenToggle" class="switch" />
    </label>
    <div class="green-body">
      <div class="green-calib">
        <figure class="green-preview">
          <img id="greenPreview" alt="" data-i18n-attr="alt:greenscreen.admin.previewAlt" hidden />
          <figcaption id="greenStatus"></figcaption>
        </figure>
        <button type="button" class="big-btn" id="greenCalibrate">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          <span class="lbl" data-i18n="greenscreen.admin.calibrate"></span>
        </button>
        <small class="hint" data-i18n="greenscreen.admin.calibrateHint"></small>
      </div>
      <div class="green-tolerance">
        <label for="greenTolerance"><strong data-i18n="greenscreen.admin.tolerance"></strong> <output id="greenToleranceValue"></output></label>
        <input type="range" id="greenTolerance" min="0" max="100" step="5" />
        <small data-i18n="greenscreen.admin.toleranceHint"></small>
      </div>
    </div>
    <h3 data-i18n="greenscreen.admin.backgrounds"></h3>
    <p class="hint" data-i18n-html="greenscreen.admin.backgroundsHint"></p>
    <div id="backgroundGrid" class="frame-grid"></div>`;
  const anchor = document.getElementById('framesCard');
  anchor.parentNode.insertBefore(card, anchor);
  const el = (id) => card.querySelector(`#${id}`);

  let current = {};
  let backgrounds = [];
  const enabled = () => 'greenScreen' in current; // the server sends no green screen settings when it is off

  function render(s) {
    current = s;
    card.hidden = !enabled();
    if (card.hidden) return;
    el('greenToggle').checked = Boolean(s.greenScreen);
    if (document.activeElement !== el('greenTolerance')) el('greenTolerance').value = s.greenTolerance ?? 50;
    el('greenToleranceValue').textContent = el('greenTolerance').value;
    const key = s.greenKey;
    el('greenStatus').textContent = key && key.at
      ? t('greenscreen.admin.calibrated', { date: new Date(key.at).toLocaleString(t('locale'), { dateStyle: 'medium', timeStyle: 'short' }) })
      : t('greenscreen.admin.notCalibrated');
    const img = el('greenPreview');
    if (s.greenPreview) {
      if (img.getAttribute('src') !== s.greenPreview) img.src = s.greenPreview;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    const chosen = s.background ? s.background.id : null;
    const tiles = backgrounds.map((b) => {
      const node = tile(b.label, b.preview, chosen === b.id, () => save({ background: b.id }));
      node.querySelector('.frame-thumb').classList.add('bg-thumb');
      return node;
    });
    if (!tiles.length) tiles.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('greenscreen.admin.noBackground') }));
    el('backgroundGrid').replaceChildren(...tiles);
  }

  async function load() {
    applyI18n(card);
    try {
      const r = await fetch('/api/backgrounds');
      backgrounds = r.ok ? await r.json() : [];
    } catch (_) {
      backgrounds = [];
    }
    render(current);
  }

  el('greenToggle').addEventListener('change', (e) => save({ greenScreen: e.target.checked }));
  el('greenTolerance').addEventListener('input', (e) => { el('greenToleranceValue').textContent = e.target.value; });
  el('greenTolerance').addEventListener('change', (e) => save({ greenTolerance: Number(e.target.value) }));
  el('greenCalibrate').addEventListener('click', async () => {
    const btn = el('greenCalibrate');
    btn.disabled = true;
    el('greenStatus').textContent = t('greenscreen.admin.calibrating');
    try {
      const r = await fetch('/api/greenscreen/calibrate', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || t('admin.saveFailed'));
      applySettings(j);
      toast(t('admin.saved'), 'ok');
    } catch (err) {
      toast(err.message);
      render(current);
    } finally {
      btn.disabled = false;
    }
  });

  (window.ADMIN_PARTS = window.ADMIN_PARTS || []).push({ load, render });
})();
