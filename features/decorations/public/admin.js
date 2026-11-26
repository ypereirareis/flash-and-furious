'use strict';

/*
 * Theme decorations switches of the admin page (module features/decorations/), in the Colour
 * theme card: on the screens, on the photos.
 * Registered in ADMIN_PARTS: admin.js calls load() at start and render(settings) on every
 * settings change, and provides save().
 */
(function decorationsSwitches() {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top: 16px; border-top: 1px solid var(--line);';
  box.innerHTML = `
    <label class="switch-row">
      <span>
        <strong data-i18n="decorations.admin.screen"></strong>
        <small data-i18n="decorations.admin.screenHint"></small>
      </span>
      <input type="checkbox" id="decoScreenToggle" class="switch" />
    </label>
    <label class="switch-row">
      <span>
        <strong data-i18n="decorations.admin.photos"></strong>
        <small data-i18n="decorations.admin.photosHint"></small>
      </span>
      <input type="checkbox" id="decoPhotoToggle" class="switch" />
    </label>
    <p class="hint" id="decoNone" hidden></p>`;
  const grid = document.getElementById('themeGrid');
  grid.parentNode.insertBefore(box, grid.nextSibling);
  const screen = box.querySelector('#decoScreenToggle');
  const photo = box.querySelector('#decoPhotoToggle');
  screen.addEventListener('change', () => save({ screenDeco: screen.checked }));
  photo.addEventListener('change', () => save({ photoDeco: photo.checked }));

  let themes = [];
  function render(s) {
    if (!('screenDeco' in s)) return; // settings not loaded yet
    screen.checked = Boolean(s.screenDeco);
    photo.checked = Boolean(s.photoDeco);
    // the chosen theme may have no decorations: the switches then have no effect
    const none = box.querySelector('#decoNone');
    const cur = themes.find((th) => th.id === s.theme);
    none.hidden = !cur || (s.decoThemes || []).includes(s.theme);
    if (cur) none.textContent = t('decorations.admin.none', { theme: cur.label });
  }
  async function load() {
    applyI18n(box);
    try { themes = await fetch('/api/themes').then((r) => r.json()); } catch (_) { themes = []; }
  }

  (window.ADMIN_PARTS = window.ADMIN_PARTS || []).push({ load, render });
})();
