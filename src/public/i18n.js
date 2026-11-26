'use strict';

/**
 * Browser side of the translations (same files as the server: /locales/<lang>.json).
 * In HTML:
 *   data-i18n="key"                     -> textContent
 *   data-i18n-html="key"                -> innerHTML (trusted locale files only)
 *   data-i18n-attr="attr:key;attr:key"  -> attributes (title, aria-label, alt, placeholder…)
 */
const I18N = { lang: 'en', dict: {}, fallback: {} };

async function loadLang(lang) {
  const get = (l) => fetch(`/locales/${l}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  [I18N.dict, I18N.fallback] = await Promise.all([get(lang), lang === 'en' ? {} : get('en')]);
  I18N.lang = lang;
  document.documentElement.lang = lang;
  applyI18n();
}

function t(key, vars = {}) {
  const find = (d) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), d);
  let v = find(I18N.dict);
  if (v === undefined) v = find(I18N.fallback);
  if (v === undefined) return key;
  const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return Array.isArray(v) ? v.map(fill) : fill(v);
}

function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

/** Language chosen in /admin (falls back to English when the server is unreachable). */
async function loadSettingsLang() {
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    await loadLang(s.lang || 'en');
    return s;
  } catch (_) {
    await loadLang('en');
    return null;
  }
}
