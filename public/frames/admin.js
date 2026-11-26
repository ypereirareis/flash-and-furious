'use strict';

/*
 * Frames card of the admin page (optional feature, see server/frames/index.js): the text of
 * the frames, and the frame applied to the photos.
 * Loaded before admin.js and registered in ADMIN_PARTS: admin.js calls load() at start and
 * render(settings) on every settings change, and provides save() and tile(). The card stays
 * hidden when the server has the feature off.
 */
(function framesCard() {
  const card = document.createElement('section');
  card.className = 'card wide';
  card.id = 'framesCard';
  card.hidden = true;
  // static markup, texts filled by applyI18n()
  card.innerHTML = `
    <h2 data-i18n="frames.admin.title"></h2>
    <form class="title-form" id="titleForm" autocomplete="off">
      <label for="titleInput" data-i18n="frames.admin.text"></label>
      <div class="title-row">
        <input id="titleInput" type="text" maxlength="60" data-i18n-attr="placeholder:frames.admin.placeholder" />
        <button type="submit" class="big-btn save-btn" data-i18n="admin.save"></button>
      </div>
      <small data-i18n="frames.admin.textHint"></small>
    </form>
    <p class="hint" data-i18n-html="frames.admin.hint"></p>
    <div id="frameGrid" class="pick-grid"></div>`;
  document.querySelector('.admin-main').append(card);
  const el = (id) => card.querySelector(`#${id}`);

  let current = {};
  let frames = [];
  let shownWith = null; // settings the frame previews were made with
  const enabled = () => 'frame' in current; // the server sends no frame settings when it is off
  // the previews show the text, the date language and the theme decorations
  const previewSettings = (s) => [s.frameTitle, s.lang, s.theme, s.photoDeco].join('|');

  async function loadFrames() {
    try {
      const r = await fetch('/api/frames');
      frames = r.ok ? await r.json() : [];
    } catch (_) {
      frames = [];
    }
  }

  function render(s) {
    current = s;
    card.hidden = !enabled();
    if (card.hidden) return;
    const sig = previewSettings(s);
    if (shownWith === null) shownWith = sig; // first settings: same as the list just loaded
    else if (shownWith !== sig) {
      shownWith = sig;
      loadFrames().then(() => render(current)); // previews made again with the new settings
    }
    if (document.activeElement !== el('titleInput')) el('titleInput').value = s.frameTitle || '';
    const chosen = s.frame ? s.frame.id : null;
    const tiles = [tile(t('frames.admin.none'), null, !chosen, () => save({ frame: null }), t('frames.admin.photoOnly'))];
    frames.forEach((f) => tiles.push(tile(f.label, f.preview, chosen === f.id, () => save({ frame: f.id }))));
    el('frameGrid').replaceChildren(...tiles);
  }

  async function load() {
    applyI18n(card);
    await loadFrames();
    render(current);
  }

  el('titleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    el('titleInput').blur();
    save({ frameTitle: el('titleInput').value });
  });

  (window.ADMIN_PARTS = window.ADMIN_PARTS || []).push({ load, render });
})();
