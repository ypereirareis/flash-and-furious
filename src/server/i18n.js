'use strict';

/**
 * UI translations, shared by the server and the browser: one JSON file per language in public/locales/.
 * Keys are dotted paths ("booth.smile"); "{name}" placeholders are replaced with the given values.
 * A missing key falls back to English, then to the key itself.
 */

const path = require('path');
const fs = require('fs');
const features = require('./features');

const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');
const FALLBACK = 'en';
const LANGS = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).sort();
// the app's texts, and those of the feature modules (features/<id>/locales/)
const dicts = Object.fromEntries(LANGS.map((l) => [l, { ...JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${l}.json`), 'utf8')), ...features.locales(l) }]));

const lookup = (dict, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
const interpolate = (s, vars) => (typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

function has(lang, key) {
  return lookup(dicts[lang], key) !== undefined || lookup(dicts[FALLBACK], key) !== undefined;
}

function t(lang, key, vars = {}) {
  let v = lookup(dicts[lang], key);
  if (v === undefined) v = lookup(dicts[FALLBACK], key);
  if (v === undefined) return key;
  return Array.isArray(v) ? v.map((x) => interpolate(x, vars)) : interpolate(v, vars);
}

const isValid = (lang) => LANGS.includes(lang);

/** Languages for the admin selector: [{ id, label }] */
const list = () => LANGS.map((id) => ({ id, label: dicts[id].language || id }));

/** All the texts of a language (for the browser). */
const dict = (lang) => dicts[lang];

module.exports = { t, has, isValid, list, dict, LANGS, FALLBACK };
