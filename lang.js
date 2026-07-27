'use strict';
/**
 * lang.js — site text, live-editable from the admin "Site Text" page.
 *
 * Two layers:
 *   1. /langs/<locale>.json  — shipped defaults, one flat key -> string map.
 *      Keep these production-clean; they're what admins see as the
 *      "default" value and what ships if nothing's been customized.
 *   2. lang_overrides table  — admin edits, (locale, key) -> value. Layered
 *      on top of the file default at read time. Saving is instant, no
 *      restart needed (this is plain data, not registered routes/hooks).
 *
 * t(key, fallback) resolution order: DB override -> langs/en.json entry ->
 * the fallback string passed at the call site. That third layer means a
 * template calling t('nav.foo', 'Foo') never breaks even for a key nobody's
 * registered yet — it just renders the fallback until someone adds it to
 * langs/en.json or overrides it from the admin page.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const LANGS_DIR = path.join(__dirname, 'langs');
fs.mkdirSync(LANGS_DIR, { recursive: true });

const DEFAULT_LOCALE = 'en';
let fileCache = null;      // { locale: { key: value } }
let overrideCache = null;  // { locale: { key: value } }
let overrideCacheAt = 0;

function loadFiles() {
  if (fileCache) return fileCache;
  fileCache = {};
  if (fs.existsSync(LANGS_DIR)) {
    for (const f of fs.readdirSync(LANGS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const locale = f.replace(/\.json$/, '');
      try { fileCache[locale] = JSON.parse(fs.readFileSync(path.join(LANGS_DIR, f), 'utf8')); }
      catch { fileCache[locale] = {}; }
    }
  }
  return fileCache;
}

function loadOverrides() {
  // Cheap 5s cache so we're not hitting sqlite on every single t() call
  // within a render (a page can easily call t() 20+ times).
  if (overrideCache && Date.now() - overrideCacheAt < 5000) return overrideCache;
  overrideCache = {};
  try {
    for (const row of db.prepare('SELECT locale, key, value FROM lang_overrides').all()) {
      (overrideCache[row.locale] ||= {})[row.key] = row.value;
    }
  } catch { /* table may not exist yet on first boot before migrations run */ }
  overrideCacheAt = Date.now();
  return overrideCache;
}

function t(key, fallback, locale) {
  const loc = locale || DEFAULT_LOCALE;
  const overrides = loadOverrides();
  if (overrides[loc]?.[key] !== undefined) return overrides[loc][key];
  const files = loadFiles();
  if (files[loc]?.[key] !== undefined) return files[loc][key];
  if (loc !== DEFAULT_LOCALE && files[DEFAULT_LOCALE]?.[key] !== undefined) return files[DEFAULT_LOCALE][key];
  return fallback !== undefined ? fallback : key;
}

/** All registered keys for the admin editor: default value + any override, per locale. */
function listAll(locale) {
  const loc = locale || DEFAULT_LOCALE;
  const files = loadFiles();
  const overrides = loadOverrides();
  const base = files[loc] || files[DEFAULT_LOCALE] || {};
  return Object.keys(base).sort().map(key => ({
    key,
    default: base[key],
    override: overrides[loc]?.[key] ?? null,
    value: overrides[loc]?.[key] ?? base[key],
  }));
}

function setOverride(locale, key, value) {
  const loc = locale || DEFAULT_LOCALE;
  if (value === '' || value === null) {
    db.prepare('DELETE FROM lang_overrides WHERE locale = ? AND key = ?').run(loc, key);
  } else {
    db.prepare(`INSERT INTO lang_overrides (locale, key, value) VALUES (?, ?, ?)
                ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(loc, key, value);
  }
  overrideCache = null; // invalidate cache immediately so the change is live on next request
}

function availableLocales() {
  return Object.keys(loadFiles());
}

module.exports = { t, listAll, setOverride, availableLocales, DEFAULT_LOCALE };
