'use strict';
/**
 * plugins.js — plugin loader for FusionDash.
 *
 * What this is: a real Node.js extension point, not a sandboxed marketplace.
 * A plugin is a folder in /plugins with a manifest + an index.js that gets
 * `require()`-d directly into this process at boot. It has the same
 * privileges as any other file in this codebase — same trust model as an
 * npm package or a WordPress plugin. Only install plugins you or someone
 * you trust wrote.
 *
 * Why boot-time only: Express can't cleanly un-register a route or
 * middleware at runtime. So toggling a plugin on/off in the admin UI just
 * flips its entry in the `enabled_plugins` setting — the actual
 * register()/route-binding happens once, here, when the process starts.
 * That's why the admin Plugins page ships with a "Restart App" button
 * (see server.js's /admin/plugins/restart) rather than pretending the
 * toggle takes effect live.
 *
 * Plugin folder shape:
 *   /plugins/<slug>/plugin.json   { name, version, description, author }
 *   /plugins/<slug>/index.js      module.exports = { register(api) { ... } }
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
fs.mkdirSync(PLUGINS_DIR, { recursive: true });

function getEnabledSlugs() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('enabled_plugins');
  if (!row) return [];
  try { return JSON.parse(row.value); } catch { return []; }
}

function setEnabledSlugs(slugs) {
  db.prepare(`INSERT INTO settings(key,value) VALUES('enabled_plugins',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(JSON.stringify(slugs));
}

function readManifest(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, slug, 'plugin.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Every plugin folder found on disk, enabled or not — for the admin list page. */
function listInstalled() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const enabled = getEnabledSlugs();
  return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, d.name, 'plugin.json')))
    .map(d => {
      const m = readManifest(d.name);
      return {
        slug: d.name,
        name: m.name || d.name,
        description: m.description || '',
        version: m.version || '0.0.0',
        author: m.author || 'Unknown',
        enabled: enabled.includes(d.name),
        hasIndex: fs.existsSync(path.join(PLUGINS_DIR, d.name, 'index.js')),
      };
    });
}

function setEnabled(slug, enabled) {
  const current = new Set(getEnabledSlugs());
  if (enabled) current.add(slug); else current.delete(slug);
  setEnabledSlugs([...current]);
}

/**
 * Loads every ENABLED plugin's index.js and calls register(api) on it.
 * Call once at boot, after ensureAuth/ensureAdmin/audit/icon exist and
 * before the catch-all 404 handler.
 */
function loadEnabledPlugins(app, ctx) {
  app.locals.pluginSidebarItems = [];
  app.locals.pluginServerCardActions = [];

  const api = {
    // Adds a nav link under the sidebar's Admin group.
    addSidebarItem({ label, href, icon }) {
      app.locals.pluginSidebarItems.push({ label, href, icon: icon || 'plug' });
    },
    // Adds a button to server cards (dashboard + My Servers), next to Edit/Delete.
    // hrefTemplate supports ":id" as a placeholder for the server's row id,
    // e.g. "/manage/:id" -> "/manage/42" for that card.
    addServerCardAction({ label, hrefTemplate, icon, style }) {
      app.locals.pluginServerCardActions.push({
        label, hrefTemplate, icon: icon || 'plug', style: style || 'neutral',
      });
    },
    // Registers a real Express route. method: 'get' | 'post'.
    registerRoute(method, routePath, ...handlers) {
      app[String(method).toLowerCase()](routePath, ...handlers);
    },
    db: ctx.db,
    ptero: ctx.ptero,
    ensureAuth: ctx.ensureAuth,
    ensureAdmin: ctx.ensureAdmin,
    audit: ctx.audit,
    icon: ctx.icon,
  };

  for (const slug of getEnabledSlugs()) {
    const entryFile = path.join(PLUGINS_DIR, slug, 'index.js');
    if (!fs.existsSync(entryFile)) {
      console.error(`[plugins] "${slug}" is enabled but has no index.js — skipped`);
      continue;
    }
    try {
      const plugin = require(entryFile);
      if (typeof plugin.register === 'function') {
        plugin.register(api);
        console.log(`[plugins] loaded: ${slug}`);
      }
    } catch (e) {
      console.error(`[plugins] FAILED to load "${slug}":`, e.message);
    }
  }
}

module.exports = { PLUGINS_DIR, listInstalled, getEnabledSlugs, setEnabled, loadEnabledPlugins };
