'use strict';

/**
 * UI colour themes (tablet + admin), picked in /admin.
 * To add a theme: copy a block below and change the id and colours, then add its name
 * under "themes" in public/locales/*.json (the `label` here is the fallback).
 *   bg / bg2: screen background; stage1 / stage2: preview area; accent: the theme's bright colour
 *   (preview border, control column); shade: tint of the overlays (r, g, b).
 *   deco-corner / deco-top / deco-pattern (optional): SVG decorations from public/deco/ (bottom-left
 *   corner of the preview, top-left corner, pattern of the control column).
 * The matching CSS is generated automatically (/themes.css).
 */

const path = require('path');

const deco = (id) => ({
  'deco-corner': `url("/deco/${id}-corner.svg")`,
  'deco-top': `url("/deco/${id}-top.svg")`,
  'deco-pattern': `url("/deco/${id}-pattern.svg")`,
});

const THEMES = [
  {
    id: 'night', label: 'Purple night',
    vars: { accent: '#a98bff', 'accent-rgb': '169, 139, 255', bg: '#1d1240', bg2: '#2b1660', stage1: '#3a2380', stage2: '#160c33', shade: '22, 12, 51', muted: '#c9bfe6' },
  },
  {
    id: 'ocean', label: 'Ocean',
    vars: { accent: '#4cc9f0', 'accent-rgb': '76, 201, 240', bg: '#071f33', bg2: '#0d4a6b', stage1: '#13618a', stage2: '#04121f', shade: '4, 22, 38', muted: '#b4d8ea' },
  },
  {
    id: 'forest', label: 'Forest',
    vars: { accent: '#2ee6a6', 'accent-rgb': '46, 230, 166', bg: '#0b241a', bg2: '#17533a', stage1: '#1f6b4a', stage2: '#06150f', shade: '6, 26, 18', muted: '#bfe3cf' },
  },
  {
    id: 'sunset', label: 'Sunset',
    vars: { accent: '#ff9f5a', 'accent-rgb': '255, 159, 90', bg: '#3a0d22', bg2: '#8c2b3c', stage1: '#a8434a', stage2: '#240614', shade: '42, 8, 24', muted: '#f4c7c7' },
  },
  {
    id: 'candy', label: 'Candy',
    vars: { accent: '#ff7ac6', 'accent-rgb': '255, 122, 198', bg: '#3b0c3a', bg2: '#8e2a7c', stage1: '#a43d90', stage2: '#230722', shade: '40, 8, 38', muted: '#f2c4e6' },
  },
  {
    id: 'gold', label: 'Black & gold',
    vars: { accent: '#e8c36a', 'accent-rgb': '232, 195, 106', bg: '#121009', bg2: '#3d321a', stage1: '#4a3d20', stage2: '#080704', shade: '14, 12, 7', muted: '#e3d3a8', heading: '#e8c36a' },
  },
  {
    id: 'black', label: 'Black',
    vars: { accent: '#e6e6f0', 'accent-rgb': '230, 230, 240', bg: '#09090c', bg2: '#22222b', stage1: '#2a2a35', stage2: '#050507', shade: '8, 8, 10', muted: '#c4c4d0' },
  },
  {
    id: 'halloween', label: 'Halloween',
    vars: {
      ...deco('halloween'), accent: '#ff7a1a', 'accent-rgb': '255, 122, 26',
      bg: '#0e0814', bg2: '#7a3008', stage1: '#4a2a5e', stage2: '#0a050e', shade: '14, 8, 20', muted: '#f6c79a', heading: '#ff8f3a' },
  },
  {
    id: 'christmas', label: 'Christmas',
    vars: {
      ...deco('christmas'), accent: '#ffd166', 'accent-rgb': '255, 209, 102',
      bg: '#073a24', bg2: '#b3122b', stage1: '#1d5a3a', stage2: '#04170f', shade: '5, 30, 20', muted: '#f3dcc0', heading: '#ffd166' },
  },
  {
    id: 'acid', label: 'Acid pop',
    vars: { accent: '#c6ff3d', 'accent-rgb': '198, 255, 61',
      bg: '#3a0a5e', bg2: '#ff2e93', stage1: '#e0408f', stage2: '#2a0645', shade: '42, 6, 69', muted: '#ffe0f4', heading: '#c6ff3d' },
  },
  {
    id: 'wedding', label: 'Wedding',
    vars: {
      ...deco('wedding'),
      accent: '#d4a95a', 'accent-rgb': '212, 169, 90',
      bg: '#f6ebe4', bg2: '#fffaf6', stage1: '#ffffff', stage2: '#f1e3da', shade: '246, 235, 228',
      text: '#4a2c3a', muted: '#8a6a78', panel: 'rgba(74, 44, 58, .06)', 'panel-strong': 'rgba(255, 255, 255, .92)',
      line: 'rgba(74, 44, 58, .15)', heading: '#b8893a', 'text-shadow': 'rgba(255, 255, 255, .8)',
    },
  },
  {
    id: 'birthday', label: 'Birthday',
    vars: {
      ...deco('birthday'),
      accent: '#ff6fb5', 'accent-rgb': '255, 111, 181',
      bg: '#10245a', bg2: '#6a2ee0', stage1: '#3a3aa0', stage2: '#0a1640', shade: '12, 24, 64', muted: '#d6dcff', heading: '#ffd23f',
    },
  },
  {
    id: 'pastel', label: 'Light pastel',
    vars: { accent: '#ff5d73', 'accent-rgb': '255, 93, 115',
      bg: '#f7ecdf', bg2: '#ffffff', stage1: '#ffffff', stage2: '#eadcca', shade: '247, 236, 223',
      text: '#2a1450', muted: '#6d5a8f', panel: 'rgba(42, 20, 80, .07)', 'panel-strong': 'rgba(255, 255, 255, .92)',
      line: 'rgba(42, 20, 80, .16)', heading: '#d9365a', 'text-shadow': 'rgba(255, 255, 255, .8)',
    },
  },
];

const DEFAULT_THEME = 'night';
const DECO_DIR = path.join(__dirname, '..', 'public', 'deco');

/**
 * SVG decoration files of a theme (to also add them to the photos, see features/decorations/),
 * or null if the theme has none. { id, corner: path, top: path }
 */
function decoFiles(id) {
  const t = THEMES.find((x) => x.id === id);
  if (!t) return null;
  const file = (key) => {
    const m = String(t.vars[key] || '').match(/\/deco\/([\w.-]+\.svg)/);
    return m ? path.join(DECO_DIR, m[1]) : null;
  };
  const files = { id: t.id, corner: file('deco-corner'), top: file('deco-top') };
  return files.corner || files.top ? files : null;
}
const ids = new Set(THEMES.map((t) => t.id));

function isValid(id) {
  return ids.has(id);
}

/** List for the admin page: [{ id, label, bg, bg2, accent, hasDeco }] */
function list() {
  return THEMES.map((t) => ({ id: t.id, label: t.label, bg: t.vars.bg, bg2: t.vars.bg2, accent: t.vars.accent, hasDeco: Boolean(decoFiles(t.id)) }));
}

// Shared values of the dark themes: every theme defines ALL its colours, otherwise a dark theme
// tile would inherit the dark text of a page in a light theme (and vice versa).
const BASE = {
  text: '#fff8f0', panel: 'rgba(255, 255, 255, .08)', line: 'rgba(255, 255, 255, .16)', heading: '#ffc94a',
  'text-shadow': 'rgba(0, 0, 0, .6)', 'deco-corner': 'none', 'deco-top': 'none', 'deco-pattern': 'none',
};

/** CSS: one [data-theme="id"] rule per theme (usable on <html> or on a tile). */
function css() {
  return THEMES.map((t) => {
    const vars = { ...BASE, 'panel-strong': `rgba(${t.vars.shade}, .8)`, ...t.vars };
    const decl = Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n');
    return `[data-theme="${t.id}"] {\n${decl}\n}`;
  }).join('\n\n') + '\n';
}

module.exports = { list, css, isValid, decoFiles, DEFAULT_THEME };
