'use strict';

/**
 * The feature modules loaded as the server does (src/server/features.js), with the parts of the
 * app they use, for the unit tests of the modules. Require it after setting CONFIG_DIR (and
 * FEATURES if needed).
 */
const express = require('express');
const settings = require('../../src/server/settings');
const i18n = require('../../src/server/i18n');
const journal = require('../../src/server/journal');
const themes = require('../../src/server/themes');
const photo = require('../../src/server/photo');
const features = require('../../src/server/features');

const lang = () => settings.get().lang;
const tr = (key, vars) => i18n.t(lang(), key, vars);
const core = {
  settings, i18n, journal, themes, express, features, lang, tr,
  translate: (m) => (typeof m === 'string' ? m : tr(m.key, m.vars)),
  chownSafe: () => {},
  cameraUnavailable: () => null,
  captureAside: async () => { throw new Error('no camera in the unit tests'); },
  settingsChanged: async () => settings.get(),
};
features.load(core);

/** A photo edited as the server does: edits { moduleId: data }, see features.forShot. */
const edit = (edits, src, dst, opts = {}) => photo.process(src, dst, { ...features.steps(edits), ...opts });

module.exports = { core, features, settings, edit, def: (id) => features.get(id) };
