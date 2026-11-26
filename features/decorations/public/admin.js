'use strict';

/*
 * "Theme decorations on photos" switch of the admin page (module features/decorations/),
 * in the Colour theme card.
 * Registered in ADMIN_PARTS: admin.js calls load() at start and render(settings) on every
 * settings change, and provides save().
 */
(function decorationsSwitch() {
  const row = document.createElement('label');
  row.className = 'switch-row';
  row.style.cssText = 'margin-top: 16px; border-top: 1px solid var(--line);';
  row.innerHTML = `
    <span>
      <strong data-i18n="decorations.admin.toggle"></strong>
      <small id="decoHint"></small>
    </span>
    <input type="checkbox" id="decoToggle" class="switch" />`;
  const grid = document.getElementById('themeGrid');
  grid.parentNode.insertBefore(row, grid.nextSibling);
  const toggle = row.querySelector('#decoToggle');
  toggle.addEventListener('change', () => save({ photoDeco: toggle.checked }));

  let themes = [];
  function render(s) {
    toggle.checked = Boolean(s.photoDeco);
    // explanation depending on the chosen theme
    const cur = themes.find((th) => th.id === s.theme);
    let hint = t('decorations.admin.hint');
    if (cur && !cur.hasDeco) hint += t('decorations.admin.none', { theme: cur.label });
    row.querySelector('#decoHint').textContent = hint;
  }
  async function load() {
    applyI18n(row);
    try { themes = await fetch('/api/themes').then((r) => r.json()); } catch (_) { themes = []; }
  }

  (window.ADMIN_PARTS = window.ADMIN_PARTS || []).push({ load, render });
})();
