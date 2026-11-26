'use strict';

/*
 * Screen files of the active feature modules (see server/features.js): their styles, and
 * their scripts for this page ('booth' or 'admin'), loaded in order. A module's script
 * registers itself in BOOTH_PARTS or ADMIN_PARTS.
 */
window.BOOTH_PARTS = window.BOOTH_PARTS || [];
window.ADMIN_PARTS = window.ADMIN_PARTS || [];

async function loadFeatures(page) {
  let list = [];
  try { list = await fetch('/api/features').then((r) => r.json()); } catch (_) { return; }
  for (const f of list) {
    for (const href of f.css) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
  for (const f of list) {
    for (const src of f[page] || []) {
      await new Promise((resolve) => {
        const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: resolve });
        document.body.append(s);
      });
    }
  }
  applyI18n(); // texts of what the modules added
}
