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
 *
 * v2 — full customization pass. The v1 engine only re-skinned Tailwind's
 * `zinc-*` / `blue-*` utility classes. That left the sidebar, mobile top bar,
 * and admin tab strip permanently stuck on a hardcoded #0c0d0f (they used
 * `bg-[#0c0d0f]` — an arbitrary Tailwind value, not `bg-zinc-950`, so nothing
 * ever touched it), and every card's glass border/tint (`border-white/[0.06]`,
 * `bg-white/[0.02]`, etc.) was hardcoded to a *white*-based overlay, which is
 * invisible on a light theme. Both are fixed below — sections.sidebar/header
 * now genuinely drive those surfaces, and effects.overlayTint switches the
 * glass-overlay math from white-based to black-based for light themes.
 */
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const THEMES_ROOT  = path.join(__dirname, 'themes');
const PRESETS_DIR   = path.join(THEMES_ROOT, 'presets');
const CUSTOM_DIR     = path.join(THEMES_ROOT, 'custom');
const DEFAULT_SLUG = 'midnight';

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
    success: '#22c55e',
    danger:  '#ef4444',
    warning: '#eab308',
  },
  // NEW — independent control over the three chrome surfaces that the old
  // engine couldn't reach (see header comment above).
  sections: {
    sidebar: {
      background: '#0c0d0f', border: 'rgba(255,255,255,.06)',
      text: '#a1a1aa', textHover: '#ffffff', textActive: '#ffffff', activeBg: 'rgba(255,255,255,.07)',
      width: '16rem',
    },
    header: { background: '#0c0d0f', border: 'rgba(255,255,255,.06)' },
    card:   { background: null, border: null, hoverBackground: null }, // null = derive from overlay system
  },
  typography: {
    fontFamily: "'Space Grotesk', system-ui, sans-serif",
    fontSource: 'google',  // 'google' | 'custom'
    googleFontUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap',
    customFontUrl: null,
    baseFontSize: '16px',
    headingFontFamily: null,     // NEW — falls back to fontFamily if unset
    headingGoogleFontUrl: null,  // NEW
    weightNormal: 400, weightMedium: 500, weightSemibold: 600, weightBold: 700, // NEW
    letterSpacing: '0', headingLetterSpacing: '0', lineHeight: '1.5',           // NEW
    monoFontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace",     // NEW
  },
  layout: {
    radiusScale: 1,
    cardShadow: '0 1px 2px rgba(0,0,0,.4)',
    spaceScale: 1,        // NEW — 0.8 compact … 1.25 spacious, scales the app's real padding/gap utilities
    borderWidth: '1px',   // NEW
  },
  effects: {              // NEW
    glass: false, glassBlur: '16px', glassOpacity: 1,
    gradientBg: false, gradientStops: [], gradientAngle: '135deg', gradientType: 'radial',
    noise: false,
    overlayTint: 'light', // 'light' | 'dark' — white-based glass overlays vs black-based (use 'dark' for light themes)
  },
  animations: {
    enabled: true,
    speed: '0.18s',
    style: 'fade',        // fade | slide | zoom | blur | spring | none
    cardHover: false,
    buttonTransition: true,
    glowAccent: false,    // NEW — soft pulse glow on solid accent buttons
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

// Every distinct white/opacity utility actually used across the app (confirmed
// via grep) — e.g. `border-white/[0.06]`, `bg-white/[0.02]`, `border-white/10`.
// These are the app's "glass card" surface. On dark themes they stay white-based
// (a light tint lifted off a dark page); on light themes effects.overlayTint
// flips the base to black so the same cards/borders are actually visible.
const OVERLAY_UTILS = [
  ['bg', 'background-color', ['0.015', '0.02', '0.03', '0.04', '0.05', '0.06', '0.08', '5', '10']],
  ['border', 'border-color', ['0.04', '0.06', '0.12', '5', '10', '20']],
  ['ring', '--tw-ring-color', ['0.04', '0.06', '0.08', '10']],
  ['divide', 'border-color', ['0.04', '5']],
];

// The app's real padding/gap scale (confirmed via grep of the most-used
// utilities) so layout density can scale actual spacing, not just a cosmetic knob.
const SPACE_SCALE_MAP = {
  '0.5': 0.125, '1': 0.25, '1.5': 0.375, '2': 0.5, '2.5': 0.625, '3': 0.75,
  '3.5': 0.875, '4': 1, '5': 1.25, '6': 1.5, '8': 2, '10': 2.5,
};

function twSelector(cls) {
  return '.' + cls.replace(/([.:/\[\]])/g, '\\$1');
}

function generateCSS(theme) {
  const p = theme.palette, sec = theme.sections, t = theme.typography, l = theme.layout, fx = theme.effects, a = theme.animations, img = theme.images;
  const vars = [];

  // Palette
  vars.push(`--fd-page-bg:${p.pageBackground};`, `--fd-body-text:${p.bodyText};`);
  for (const s of NEUTRAL_SHADES) vars.push(`--fd-n${s}:${p.neutral[s]};`);
  for (const s of ACCENT_SHADES)  vars.push(`--fd-a${s}:${p.accent[s]};`);
  vars.push(`--fd-success:${p.success};`, `--fd-danger:${p.danger};`, `--fd-warning:${p.warning};`);

  // Sections
  const cardBg      = sec.card.background      || `rgba(var(--fd-overlay-rgb),calc(.03 * var(--fd-overlay-strength)))`;
  const cardBorder   = sec.card.border          || `rgba(var(--fd-overlay-rgb),calc(.06 * var(--fd-overlay-strength)))`;
  const cardHoverBg = sec.card.hoverBackground || `rgba(var(--fd-overlay-rgb),calc(.05 * var(--fd-overlay-strength)))`;
  vars.push(`--fd-sidebar-bg:${sec.sidebar.background};`, `--fd-sidebar-border:${sec.sidebar.border};`);
  vars.push(`--fd-sidebar-text:${sec.sidebar.text};`, `--fd-sidebar-text-hover:${sec.sidebar.textHover};`);
  vars.push(`--fd-sidebar-text-active:${sec.sidebar.textActive};`, `--fd-sidebar-active-bg:${sec.sidebar.activeBg};`);
  vars.push(`--fd-sidebar-width:${sec.sidebar.width};`);
  vars.push(`--fd-header-bg:${sec.header.background};`, `--fd-header-border:${sec.header.border};`);

  // Typography
  vars.push(`--fd-font:${t.fontFamily};`, `--fd-font-heading:${t.headingFontFamily || t.fontFamily};`);
  vars.push(`--fd-font-mono:${t.monoFontFamily};`, `--fd-font-size:${t.baseFontSize};`);
  vars.push(`--fd-weight-normal:${t.weightNormal};`, `--fd-weight-medium:${t.weightMedium};`);
  vars.push(`--fd-weight-semibold:${t.weightSemibold};`, `--fd-weight-bold:${t.weightBold};`);
  vars.push(`--fd-tracking:${t.letterSpacing};`, `--fd-tracking-heading:${t.headingLetterSpacing};`, `--fd-leading:${t.lineHeight};`);

  // Layout / spacing
  vars.push(`--fd-radius-scale:${l.radiusScale};`, `--fd-shadow:${l.cardShadow};`);
  vars.push(`--fd-space-scale:${l.spaceScale};`, `--fd-border-w:${l.borderWidth};`);

  // Effects
  const overlayRgb = fx.overlayTint === 'dark' ? '0,0,0' : '255,255,255';
  vars.push(`--fd-overlay-rgb:${overlayRgb};`);
  vars.push(`--fd-overlay-strength:${fx.glass ? (fx.glassOpacity ?? 1) : 1};`);
  vars.push(`--fd-blur:${fx.glass ? fx.glassBlur : '0px'};`);

  vars.push(`--fd-speed:${a.enabled ? a.speed : '0s'};`);

  const rules = [];
  rules.push(`:root{${vars.join('')}}`);

  // Fonts
  if (t.fontSource === 'custom' && t.customFontUrl) {
    rules.push(`@font-face{font-family:'FDCustomFont';src:url('${t.customFontUrl}');font-display:swap;}`);
  }
  rules.push(`body{background:var(--fd-page-bg);color:var(--fd-body-text);font-family:var(--fd-font);font-size:var(--fd-font-size);letter-spacing:var(--fd-tracking);line-height:var(--fd-leading);}`);
  rules.push(`h1,h2,h3,h4,h5,h6{font-family:var(--fd-font-heading);letter-spacing:var(--fd-tracking-heading);}`);
  rules.push(`code,pre,.font-mono{font-family:var(--fd-font-mono) !important;}`);
  rules.push(`.font-medium{font-weight:var(--fd-weight-medium) !important;}`);
  rules.push(`.font-semibold{font-weight:var(--fd-weight-semibold) !important;}`);
  rules.push(`.font-bold,.font-extrabold{font-weight:var(--fd-weight-bold) !important;}`);

  // Base zinc/blue re-skin (existing mechanism)
  for (const s of NEUTRAL_SHADES) for (const [prefix, prop] of NEUTRAL_PROPS) {
    rules.push(`.${prefix}-zinc-${s}{${prop}:var(--fd-n${s}) !important;}`);
  }
  for (const s of ACCENT_SHADES) for (const [prefix, prop] of NEUTRAL_PROPS) {
    rules.push(`.${prefix}-blue-${s}{${prop}:var(--fd-a${s}) !important;}`);
  }

  // text-white is used ~260x across the app as "primary heading/label text on
  // the dark surface" — on a light theme that's invisible, so it now follows
  // body text. The 5 spots where it's deliberately a white label on a solid
  // accent button (login/register CTAs) are restored right after.
  rules.push(`.text-white{color:var(--fd-body-text) !important;}`);
  rules.push(`.bg-blue-500.text-white,.bg-blue-400.text-white,.bg-blue-600.text-white{color:#fff !important;}`);

  // Semantic status colors (success/danger/warning) — the handful of green/red/
  // yellow utilities actually used for status, not decorative color.
  rules.push(`.text-green-400,.text-green-300{color:var(--fd-success) !important;}`);
  rules.push(`.bg-green-500,.bg-green-400{background-color:var(--fd-success) !important;}`);
  rules.push(`.ring-green-500{--tw-ring-color:var(--fd-success) !important;}`);
  rules.push(`.text-red-400,.text-red-300{color:var(--fd-danger) !important;}`);
  rules.push(`.bg-red-500,.bg-red-400{background-color:var(--fd-danger) !important;}`);
  rules.push(`.border-red-500{border-color:var(--fd-danger) !important;}`);
  rules.push(`.text-yellow-400{color:var(--fd-warning) !important;}`);

  // Sidebar / header (the actual fix — see file header comment)
  rules.push(`.fd-sidebar{background:var(--fd-sidebar-bg) !important;border-color:var(--fd-sidebar-border) !important;width:var(--fd-sidebar-width) !important;}`);
  rules.push(`.fd-header{background:var(--fd-header-bg) !important;border-color:var(--fd-header-border) !important;}`);
  rules.push(`.app-main{margin-left:var(--fd-sidebar-width) !important;width:calc(100% - var(--fd-sidebar-width)) !important;}`);
  rules.push(`@media (max-width:1023px){.app-main{margin-left:0 !important;width:100% !important;}}`);
  rules.push(`.nav-link{color:var(--fd-sidebar-text) !important;}`);
  rules.push(`.nav-link:hover{background:var(--fd-sidebar-active-bg) !important;color:var(--fd-sidebar-text-hover) !important;}`);
  rules.push(`.nav-active{background:var(--fd-sidebar-active-bg) !important;color:var(--fd-sidebar-text-active) !important;}`);

  // Card surfaces: explicit section override wins; otherwise every white/opacity
  // "glass" utility below derives from the same overlay system.
  if (sec.card.background) rules.push(`.rounded-2xl,.rounded-xl{background-color:${cardBg} !important;}`);
  if (sec.card.border)     rules.push(`.rounded-2xl,.rounded-xl{border-color:${cardBorder} !important;}`);

  for (const [prefix, cssProp, alphas] of OVERLAY_UTILS) {
    for (const al of alphas) {
      const isDecimal = al.includes('.');
      const cls = isDecimal ? `${prefix}-white/[${al}]` : `${prefix}-white/${al}`;
      const alphaNum = isDecimal ? parseFloat(al) : parseFloat(al) / 100;
      rules.push(`${twSelector(cls)}{${cssProp}:rgba(var(--fd-overlay-rgb),calc(${alphaNum} * var(--fd-overlay-strength))) !important;}`);
    }
  }

  // Glass blur (Apple Music / Arc style frosted panels)
  if (fx.glass) {
    rules.push(`.rounded-2xl,.rounded-xl,.fd-sidebar,.fd-header{backdrop-filter:blur(var(--fd-blur));-webkit-backdrop-filter:blur(var(--fd-blur));}`);
  }

  // Gradient background (Stripe mesh / Apple Music ambient wash style)
  if (fx.gradientBg && Array.isArray(fx.gradientStops) && fx.gradientStops.length) {
    const stops = fx.gradientStops.join(',');
    const grad = fx.gradientType === 'linear'
      ? `linear-gradient(${fx.gradientAngle || '135deg'},${stops})`
      : `radial-gradient(ellipse at 30% 0%,${stops})`;
    rules.push(`body{background-image:${grad};background-attachment:fixed;}`);
  }

  // Noise texture (subtle film-grain overlay)
  if (fx.noise) {
    rules.push(`body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.035;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}`);
  }

  // Roundness scale (rounded-full is left alone on purpose — it's a pill/circle
  // shape, not a decorative radius, so it shouldn't move with this slider)
  rules.push(`.rounded{border-radius:calc(.25rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-lg{border-radius:calc(.5rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-xl{border-radius:calc(.75rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-2xl{border-radius:calc(1rem * var(--fd-radius-scale)) !important;}`);
  rules.push(`.rounded-3xl{border-radius:calc(1.5rem * var(--fd-radius-scale)) !important;}`);

  // Border width (targets exactly `.border`, not `.border-2`/`.border-4`, so
  // deliberately-thick borders elsewhere are untouched)
  rules.push(`.border,.border-t,.border-b,.border-l,.border-r{border-width:var(--fd-border-w) !important;}`);

  // Density: scales the app's real padding/gap utilities
  for (const [suf, rem] of Object.entries(SPACE_SCALE_MAP)) {
    rules.push(`.p-${suf}{padding:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
    rules.push(`.px-${suf}{padding-left:calc(${rem}rem * var(--fd-space-scale)) !important;padding-right:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
    rules.push(`.py-${suf}{padding-top:calc(${rem}rem * var(--fd-space-scale)) !important;padding-bottom:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
    rules.push(`.gap-${suf}{gap:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
    rules.push(`.gap-x-${suf}{column-gap:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
    rules.push(`.gap-y-${suf}{row-gap:calc(${rem}rem * var(--fd-space-scale)) !important;}`);
  }

  // Animations
  if (a.enabled && a.style !== 'none') {
    let fromState = 'opacity:0;transform:translateY(4px)', toState = 'opacity:1;transform:none', easing = 'ease';
    if (a.style === 'slide') {
      fromState = 'opacity:0;transform:translateY(14px)';
    } else if (a.style === 'zoom') {
      fromState = 'opacity:0;transform:scale(0.97)';
    } else if (a.style === 'blur') {
      fromState = 'opacity:0;filter:blur(6px);transform:translateY(4px)'; toState = 'opacity:1;filter:blur(0);transform:none';
    } else if (a.style === 'spring') {
      fromState = 'opacity:0;transform:scale(0.95) translateY(8px)'; easing = 'cubic-bezier(0.34,1.56,0.64,1)';
    }
    rules.push(`@keyframes fdFadeIn{from{${fromState}}to{${toState}}}`);
    rules.push(`main{animation:fdFadeIn var(--fd-speed) ${easing};}`);
  } else {
    rules.push(`main{animation:none;}`);
  }
  if (a.buttonTransition) {
    rules.push(`button,a.tab-btn,input,select,textarea{transition:background-color var(--fd-speed) ease,color var(--fd-speed) ease,border-color var(--fd-speed) ease,transform var(--fd-speed) ease,box-shadow var(--fd-speed) ease;}`);
  }
  if (a.cardHover) {
    rules.push(`.rounded-2xl:hover,.rounded-xl:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35);}`);
  }
  if (a.glowAccent) {
    rules.push(`@keyframes fdGlow{0%,100%{box-shadow:0 0 0 0 var(--fd-a500)}50%{box-shadow:0 0 12px 3px var(--fd-a500)}}`);
    rules.push(`.bg-blue-500{animation:fdGlow 2.8s ease-in-out infinite;}`);
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
