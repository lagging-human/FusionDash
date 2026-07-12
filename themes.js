'use strict';
/**
 * themes.js — Theme engine for FusionDash.
 *
 * Storage model:
 *   /themes/presets/<slug>/theme.json   — shipped with the app, read-only, tracked by git
 *   /themes/custom/<slug>/theme.json    — admin-created, editable, protected from
 *                                          auto-update via .fusionignore (see auto-update.js)
 *   /themes/custom/<slug>/assets/*      — uploaded logos/fonts/backgrounds for that theme
 *
 * Only the *active theme slug* lives in the sqlite `settings` table (a tiny pointer,
 * not "theme data"), since that table is runtime state and was never meant to be
 * hand-edited the way CSS/fonts/images are.
 */
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const THEMES_ROOT   = path.join(__dirname, 'themes');
const PRESETS_DIR    = path.join(THEMES_ROOT, 'presets');
const CUSTOM_DIR      = path.join(THEMES_ROOT, 'custom');
const DEFAULT_SLUG  = 'midnight';

fs.mkdirSync(PRESETS_DIR, { recursive: true });
fs.mkdirSync(CUSTOM_DIR, { recursive: true });

// ── Defaults (also doubles as the deep-merge base so partial/older theme.json
//    files never crash the CSS generator if a field is missing) ─────────────
const DEFAULT_THEME = {
  slug: 'midnight',
  name: 'Midnight (Default)',
  palette: {
    pageBackground: '#0c0d0f',
    bodyText: '#e4e4e7',
    neutral: { '950': '#09090b', '900': '#18181b', '800': '#27272a', '700': '#3f3f46', '600': '#52525b', '500': '#71717a', '400': '#a1a1aa', '300': '#d4d4d8' },
    accent:  { '300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb' },
  },
  typography: {
    fontFamily: "'Space Grotesk', system-ui, sans-serif",
    fontSource: 'google',  // 'google' | 'custom'
    googleFontUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap',
    customFontUrl: null,
    baseFontSize: '16px',
  },
  layout: {
    radiusScale: 1,
    cardShadow: '0 1px 2px rgba(0,0,0,.4)',
  },
  animations: {
    enabled: true,
    speed: '0.18s',
    style: 'fade',        // fade | slide | none
    cardHover: false,
    buttonTransition: true,
  },
  images: {
    logoUrl: null,
    loginBackgroundUrl: null,
    bodyBackgroundUrl: null,
  },
  customCss: '',
};

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'theme';
}

function dirFor(slug) {
  if (!slug || /[./\\]/.test(slug)) return null; // reject traversal-y slugs from URL params
  const custom = path.join(CUSTOM_DIR, slug);
  if (fs.existsSync(path.join(custom, 'theme.json'))) return { dir: custom, preset: false };
  const preset = path.join(PRESETS_DIR, slug);
  if (fs.existsSync(path.join(preset, 'theme.json'))) return { dir: preset, preset: true };
  return null;
}

function loadTheme(slug) {
  const loc = dirFor(slug);
  if (!loc) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(loc.dir, 'theme.json'), 'utf8'));
    return { ...deepMerge(DEFAULT_THEME, raw), slug, preset: loc.preset };
  } catch {
    return { ...DEFAULT_THEME, slug, preset: loc.preset };
  }
}

function listThemes() {
  const activeSlug = getActiveSlug();
  const fromDir = (dir, preset) => fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'theme.json')))
        .map(d => {
          const t = loadTheme(d.name);
          return {
            slug: d.name, name: t?.name || d.name, preset, active: d.name === activeSlug,
            swatches: { bg: t.palette.pageBackground, panel: t.palette.neutral['900'], accent: t.palette.accent['500'] },
          };
        })
    : [];
  return [...fromDir(PRESETS_DIR, true), ...fromDir(CUSTOM_DIR, false)];
}

function getActiveSlug() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('active_theme');
  const slug = row?.value || DEFAULT_SLUG;
  return dirFor(slug) ? slug : DEFAULT_SLUG;
}

function setActiveSlug(slug) {
  if (!dirFor(slug)) throw new Error('Theme not found: ' + slug);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('active_theme', slug);
}

function getActiveTheme() {
  return loadTheme(getActiveSlug()) || { ...DEFAULT_THEME, slug: DEFAULT_SLUG, preset: true };
}

function createTheme({ name, cloneFrom }) {
  const base = cloneFrom ? (loadTheme(cloneFrom) || DEFAULT_THEME) : DEFAULT_THEME;
  let slug = slugify(name);
  let i = 2;
  while (fs.existsSync(path.join(CUSTOM_DIR, slug))) { slug = `${slugify(name)}-${i++}`; }
  const dir = path.join(CUSTOM_DIR, slug);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const { slug: _s, preset: _p, ...clean } = base;
  const theme = { ...clean, name: name || 'Untitled Theme' };
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme, null, 2));
  return slug;
}

function saveTheme(slug, updates) {
  const loc = dirFor(slug);
  if (!loc || loc.preset) throw new Error('Only custom themes can be edited.');
  const current = loadTheme(slug);
  const { slug: _s, preset: _p, ...cleanCurrent } = current;
  const merged = deepMerge(cleanCurrent, updates);
  fs.writeFileSync(path.join(loc.dir, 'theme.json'), JSON.stringify(merged, null, 2));
  return merged;
}

function deleteTheme(slug) {
  const loc = dirFor(slug);
  if (!loc || loc.preset) throw new Error('Only custom themes can be deleted.');
  if (getActiveSlug() === slug) throw new Error('Cannot delete the active theme. Activate another theme first.');
  fs.rmSync(loc.dir, { recursive: true, force: true });
}

function assetDir(slug) {
  const loc = dirFor(slug);
  if (!loc) throw new Error('Theme not found: ' + slug);
  return path.join(loc.dir, 'assets');
}

function assetUrl(slug, filename) {
  const loc = dirFor(slug);
  const kind = loc?.preset ? 'presets' : 'custom';
  return `/theme-assets/${kind}/${slug}/assets/${filename}`;
}

// ── CSS generation ───────────────────────────────────────────────────────────
// Re-skins the Tailwind utility classes actually used across the app's views
// (confirmed via a full grep of the codebase) by redeclaring them after the
// Tailwind CDN stylesheet loads, driven by CSS custom properties.
const NEUTRAL_SHADES = ['950', '900', '800', '700', '600', '500', '400', '300'];
const ACCENT_SHADES   = ['300', '400', '500', '600'];
const NEUTRAL_PROPS = [
  ['bg', 'background-color'], ['text', 'color'], ['ring', '--tw-ring-color'], ['border', 'border-color'],
];

function generateCSS(theme) {
  const p = theme.palette, t = theme.typography, l = theme.layout, a = theme.animations, img = theme.images;
  const vars = [];
  vars.push(`--fd-page-bg:${p.pageBackground};`, `--fd-body-text:${p.bodyText};`);
  for (const s of NEUTRAL_SHADES) vars.push(`--fd-n${s}:${p.neutral[s]};`);
  for (const s of ACCENT_SHADES)  vars.push(`--fd-a${s}:${p.accent[s]};`);
  vars.push(`--fd-font:${t.fontFamily};`, `--fd-font-size:${t.baseFontSize};`);
  vars.push(`--fd-radius-scale:${l.radiusScale};`, `--fd-shadow:${l.cardShadow};`);
  vars.push(`--fd-speed:${a.enabled ? a.speed : '0s'};`);

  const rules = [];
  rules.push(`:root{${vars.join('')}}`);
  if (t.fontSource === 'custom' && t.customFontUrl) {
    rules.push(`@font-face{font-family:'FDCustomFont';src:url('${t.customFontUrl}');font-display:swap;}`);
  }
  rules.push(`body{background:var(--fd-page-bg);color:var(--fd-body-text);font-family:var(--fd-font);font-size:var(--fd-font-size);}`);

  for (const s of NEUTRAL_SHADES) for (const [prefix, prop] of NEUTRAL_PROPS) {
    rules.push(`.${prefix}-zinc-${s}{${prop}:var(--fd-n${s}) !important;}`);
  }
  for (const s of ACCENT_SHADES) for (const [prefix, prop] of NEUTRAL_PROPS) {
    rules.push(`.${prefix}-blue-${s}{${prop}:var(--fd-a${s}) !important;}`);
  }

  // Roundness scale (rounded-full is left alone on purpose — it's a pill/circle
  // shape, not a decorative radius, so it shouldn't move with this slider)
  rules.push(`.rounded{border-radius:calc(.25rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-lg{border-radius:calc(.5rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-xl{border-radius:calc(.75rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-2xl{border-radius:calc(1rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-3xl{border-radius:calc(1.5rem * var(--fd-radius-scale)) !important;}`);

  // Animations
  if (a.enabled && a.style !== 'none') {
    const from = a.style === 'slide' ? 'opacity:0;transform:translateY(14px)' : 'opacity:0;transform:translateY(4px)';
    rules.push(`@keyframes fdFadeIn{from{${from}}to{opacity:1;transform:none}}`);
    rules.push(`main{animation:fdFadeIn var(--fd-speed) ease;}`);
  } else {
    rules.push(`main{animation:none;}`);
  }
  if (a.buttonTransition) {
    rules.push(`button,a.tab-btn,input,select,textarea{transition:background-color var(--fd-speed) ease,color var(--fd-speed) ease,border-color var(--fd-speed) ease,transform var(--fd-speed) ease;}`);
  }
  if (a.cardHover) {
    rules.push(`.rounded-2xl:hover,.rounded-xl:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35);}`);
  }

  // Images
  if (img.bodyBackgroundUrl) {
    rules.push(`body{background-image:url('${img.bodyBackgroundUrl}');background-size:cover;background-attachment:fixed;background-position:center;}`);
  }
  if (img.loginBackgroundUrl) {
    rules.push(`body.has-login-bg{background-image:url('${img.loginBackgroundUrl}'),linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55));background-blend-mode:darken;background-size:cover;background-position:center;}`);
  }

  if (theme.customCss) rules.push(theme.customCss);

  return rules.join('\n');
}

module.exports = {
  THEMES_ROOT, PRESETS_DIR, CUSTOM_DIR, DEFAULT_SLUG, DEFAULT_THEME,
  listThemes, loadTheme, getActiveSlug, setActiveSlug, getActiveTheme,
  createTheme, saveTheme, deleteTheme, assetDir, assetUrl, generateCSS, slugify,
};
