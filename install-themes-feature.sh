#!/usr/bin/env bash
# Creates/overwrites every file for the Admin Themes feature.
# Run this from your FusionDash project root (same folder as server.js).
set -e

mkdir -p "themes/presets/aurora"
mkdir -p "themes/presets/daylight"
mkdir -p "themes/presets/midnight"
mkdir -p "themes/presets/sunset"
mkdir -p "views"
mkdir -p "views/admin"
mkdir -p "views/components"

echo "Writing server.js"
cat > "server.js" << 'FUSIONDASH_EOF_SERVER_JS'
require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const passport = require('./passport-config');
const db       = require('./db');
const path     = require('path');
const multer   = require('multer');
const ptero    = require('./pterodactyl');
const payments = require('./payments');
const { startAutoUpdater, checkForUpdate } = require('./auto-update');
const { icon } = require('./icons');
const { getLiveStats, getOrCreateInstallId } = require('./telemetry');
const { startQueue, enqueue, getUserQueueStatus, getQueueInfo, getPositionForJob, createServerImmediate } = require('./queue');
const { audit } = require('./audit');
const { firstRunSetup } = require('./first-run');
const themes   = require('./themes');

const app = express();
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));
app.use('/theme-assets', express.static(path.join(__dirname, 'themes')));
app.use(express.urlencoded({ extended: true }));
app.use('/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function settingsObj() {
  return Object.fromEntries(
    db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])
  );
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
function nowISO()          { return new Date().toISOString(); }
function nextBillingDate() { const d = new Date(); d.setDate(d.getDate()+30); return d.toISOString(); }

/** Give a new user their default resource pool based on current settings */
function grantDefaultResources(userId) {
  const s = settingsObj();
  db.prepare(`
    UPDATE users SET
      res_memory=?,res_disk=?,res_cpu=?,res_ports=?,res_databases=?,res_backups=?
    WHERE id=? AND res_memory=0 AND res_disk=0
  `).run(
    parseInt(s.default_memory||'6144',10),
    parseInt(s.default_disk||'5120',10),
    parseInt(s.default_cpu||'80',10),
    parseInt(s.default_ports||'2',10),
    parseInt(s.default_databases||'1',10),
    parseInt(s.default_backups||'1',10),
    userId
  );
}

/** Add coins and log the transaction */
function addCoins(userId, delta, reason, ref=null) {
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(delta, userId);
  db.prepare('INSERT INTO coin_log(user_id,delta,reason,ref) VALUES(?,?,?,?)').run(userId, delta, reason, ref);
}

/** Consume resources when creating a server */
function consumeResources(userId, { memory, disk, cpu, ports=1, databases=0, backups=0 }) {
  db.prepare(`
    UPDATE users SET
      used_memory=used_memory+?,used_disk=used_disk+?,used_cpu=used_cpu+?,
      used_ports=used_ports+?,used_databases=used_databases+?,used_backups=used_backups+?
    WHERE id=?
  `).run(memory, disk, cpu, ports, databases, backups, userId);
}

/** Return resources when deleting a server */
function returnResources(userId, { memory, disk, cpu, ports=1, databases=0, backups=0 }) {
  db.prepare(`
    UPDATE users SET
      used_memory=MAX(0,used_memory-?),used_disk=MAX(0,used_disk-?),used_cpu=MAX(0,used_cpu-?),
      used_ports=MAX(0,used_ports-?),used_databases=MAX(0,used_databases-?),used_backups=MAX(0,used_backups-?)
    WHERE id=?
  `).run(memory, disk, cpu, ports, databases, backups, userId);
}

/** Get a user's available (free) resources */
function freeResources(user) {
  return {
    memory:    user.res_memory    - user.used_memory,
    disk:      user.res_disk      - user.used_disk,
    cpu:       user.res_cpu       - user.used_cpu,
    ports:     user.res_ports     - user.used_ports,
    databases: user.res_databases - user.used_databases,
    backups:   user.res_backups   - user.used_backups,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────────────────────────────────────
const getUser           = db.prepare('SELECT * FROM users WHERE id=?');
const getServersByUser  = db.prepare('SELECT * FROM servers WHERE user_id=? ORDER BY id ASC');
const getServerById     = db.prepare('SELECT * FROM servers WHERE id=?');
const deleteServerRow   = db.prepare('DELETE FROM servers WHERE id=?');
const getAllPlans        = db.prepare('SELECT * FROM plans WHERE active=1');
const getPlanByKey      = db.prepare('SELECT * FROM plans WHERE key=? AND active=1');
const getAllUsers        = db.prepare('SELECT * FROM users ORDER BY created_at DESC');
const getStoreItems     = db.prepare('SELECT * FROM store_items WHERE active=1');
const getAllStoreItems   = db.prepare('SELECT * FROM store_items');
const getAllServersAdmin = db.prepare(`SELECT s.*,u.username,u.email FROM servers s JOIN users u ON s.user_id=u.id ORDER BY s.id DESC`);

const insertServer = db.prepare(`
  INSERT INTO servers
    (user_id,pterodactyl_server_id,pterodactyl_identifier,name,description,plan,
     egg_id,nest_id,node_id,memory,disk,cpu,ports,databases,backups,
     subscription_active,subscription_gateway,billing_cycle_start,billing_cycle_end)
  VALUES
    (@user_id,@pterodactyl_server_id,@pterodactyl_identifier,@name,@description,@plan,
     @egg_id,@nest_id,@node_id,@memory,@disk,@cpu,@ports,@databases,@backups,
     @subscription_active,@subscription_gateway,@billing_cycle_start,@billing_cycle_end)
`);

const insertTransaction = db.prepare(`
  INSERT INTO transactions(user_id,plan_key,gateway,gateway_order_id,amount,currency,status,type,deploy_config)
  VALUES(@user_id,@plan_key,@gateway,@gateway_order_id,@amount,@currency,'pending',@type,@deploy_config)
`);
const getTransactionByOrderId = db.prepare('SELECT * FROM transactions WHERE gateway_order_id=? AND gateway=?');
const markTransactionPaid     = db.prepare(`UPDATE transactions SET status='paid',gateway_ref=?,server_id=? WHERE id=?`);
const markTransactionFailed   = db.prepare(`UPDATE transactions SET status='failed' WHERE id=?`);

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}
function ensureAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.is_admin) return next();
  res.status(403).render('error', { message: 'Admin access required.', pageTitle: 'Error' });
}

// Refresh session user from DB on every request so coins/resources are current
app.use((req, res, next) => {
  if (req.isAuthenticated()) req.user = getUser.get(req.user.id) || req.user;
  // Make branding available to every view without explicit passing
  // Use a simple in-process cache (invalidated on settings save) to avoid hitting DB on every request
  const s = settingsObj();
  res.locals.appName    = s.app_name        || 'FusionDash';
  res.locals.appFavicon = s.app_favicon_url || '';
  res.locals.icon       = icon;
  res.locals.appVersion = require('./package.json').version || '1.0.0';
  // Dashboard Credit: when disabled, hides FusionDash promo/GitHub links across public views
  res.locals.hideCredit = s.hide_credit === '1';

  // Active theme — applies site-wide (login, dashboard, billing, checkout, admin)
  const activeTheme = themes.getActiveTheme();
  res.locals.theme    = activeTheme;
  res.locals.themeCSS = themes.generateCSS(activeTheme);
  if (activeTheme.images.logoUrl) res.locals.appFavicon = activeTheme.images.logoUrl;

  next();

});

// ─────────────────────────────────────────────────────────────────────────────
// Public
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  const s = settingsObj();
  const statVisibility = {
    users:             s.stat_show_users             !== '0',
    servers:           s.stat_show_servers           !== '0',
    paid_transactions: s.stat_show_paid_transactions !== '0',
    free_servers:      s.stat_show_free_servers      !== '0',
    paid_servers:      s.stat_show_paid_servers      !== '0',
    admins:            s.stat_show_admins            !== '0',
    revenue:           s.stat_show_revenue           !== '0',
  };
  res.render('home', { user: req.user, stats: getLiveStats(), statVisibility, pageTitle: 'Home' });
});

app.get('/api/stats', (req, res) => {
  const stats = getLiveStats();
  delete stats.install_id;
  const s = settingsObj();
  if (s.stat_show_users             === '0') delete stats.users;
  if (s.stat_show_servers           === '0') delete stats.servers;
  if (s.stat_show_paid_transactions === '0') delete stats.paid_transactions;
  if (s.stat_show_free_servers      === '0') delete stats.free_servers;
  if (s.stat_show_paid_servers      === '0') delete stats.paid_servers;
  if (s.stat_show_admins            === '0') delete stats.admins;
  if (s.stat_show_revenue           === '0') { delete stats.revenue_inr; delete stats.revenue_usd; }
  res.json({ ok: true, stats });
});

// Public plans page + API
app.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY price_inr ASC').all();
  res.render('plans', { user: req.user, plans, pageTitle: 'Plans' });
});

app.get('/api/plans', (req, res) => {
  const plans = db.prepare(`
    SELECT key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports
    FROM plans WHERE active=1 ORDER BY price_inr ASC
  `).all();
  res.json({ ok: true, plans });
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('login', { error: req.query.error || null, pageTitle: 'Login' });
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────────────────────────────────────────
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login?error=Discord+login+failed' }),
  (req, res) => { grantDefaultResources(req.user.id); res.redirect('/dashboard'); }
);
app.get('/auth/google', passport.authenticate('google'));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=Google+login+failed' }),
  (req, res) => { grantDefaultResources(req.user.id); res.redirect('/dashboard'); }
);
app.post('/logout', (req, res, next) => req.logout(err => err ? next(err) : res.redirect('/')));

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────
app.get('/dashboard', ensureAuth, (req, res) => {
  const servers = getServersByUser.all(req.user.id);
  const free    = freeResources(req.user);
  const s       = settingsObj();
  const renewal = {
    enabled:    s.renewal_enabled    === '1',
    price:      parseInt(s.renewal_price    || '5',  10),
    days:       parseInt(s.renewal_days     || '30', 10),
    graceDays:  parseInt(s.renewal_grace_days || '1', 10),
  };
  res.render('dashboard', {
    user: req.user, servers, free, renewal, pageTitle: 'Dashboard',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.get('/billing', ensureAuth, (req, res) => {
  const servers = getServersByUser.all(req.user.id);
  const plans   = getAllPlans.all();
  res.render('billing', {
    user: req.user, servers, plans, pageTitle: 'Billing',
    error: req.query.error||null, success: req.query.success||null
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create Server
// ─────────────────────────────────────────────────────────────────────────────

// Filter nests/eggs from panel against the admin-managed eggs table.
// If the eggs table is empty, returns all panel eggs unfiltered.
function filterNestsByAllowedEggs(nests) {
  const allowed = db.prepare('SELECT * FROM eggs WHERE active=1').all();
  if (!allowed.length) return nests; // no eggs configured yet — show everything
  const allowedSet = new Set(allowed.map(e => `${e.nest_id}:${e.egg_id}`));
  const result = [];
  for (const nest of nests) {
    const eggs = nest.eggs.filter(egg => allowedSet.has(`${nest.id}:${egg.id}`));
    if (eggs.length) result.push({ ...nest, eggs });
  }
  return result;
}

app.get('/servers/create', ensureAuth, async (req, res) => {
  if (!req.user.pterodactyl_user_id) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Your account is not linked to the panel yet. Try logging out and back in.'));
  }
  try {
    const [rawNests, nodes] = await Promise.all([ptero.listNestsWithEggs(), ptero.listNodes()]);
    const nests = filterNestsByAllowedEggs(rawNests);
    const s = settingsObj();
    const free = freeResources(req.user);
    res.render('servers/create', {
      user: req.user, nests, nodes, free, pageTitle: 'New Server',
      dashUrl: s.dashboard_url || process.env.BASE_URL || 'http://localhost:3000',
      error: req.query.error||null
    });
  } catch (err) {
    console.error(err.response?.data||err.message);
    res.redirect('/dashboard?error=' + encodeURIComponent('Could not load options from the panel.'));
  }
});

app.post('/servers/create', ensureAuth, async (req, res) => {
  if (!req.user.pterodactyl_user_id) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Account not linked to panel.'));
  }

  const nestId    = parseInt(req.body.nest_id,  10);
  const eggId     = parseInt(req.body.egg_id,   10);
  const nodeId    = parseInt(req.body.node_id,  10);
  const name      = (req.body.name || `${req.user.username}'s Server`).slice(0, 60);
  const memory    = parseInt(req.body.memory,    10) || 0;
  const disk      = parseInt(req.body.disk,      10) || 0;
  const cpu       = parseInt(req.body.cpu,       10) || 0;
  const ports     = parseInt(req.body.ports,     10) || 1;
  const databases = parseInt(req.body.databases, 10) || 0;
  const backups   = parseInt(req.body.backups,   10) || 0;

  if (!nestId || !eggId || !nodeId) {
    return res.redirect('/servers/create?error=' + encodeURIComponent('Please select software and a node.'));
  }

  // Validate against user's free pool
  const user = getUser.get(req.user.id);
  const free = freeResources(user);
  const errors = [];
  if (memory    <= 0 || memory    > free.memory)    errors.push(`RAM must be 1–${free.memory} MB`);
  if (disk      <= 0 || disk      > free.disk)      errors.push(`Disk must be 1–${free.disk} MB`);
  if (cpu       <= 0 || cpu       > free.cpu)       errors.push(`CPU must be 1–${free.cpu}%`);
  if (ports     < 1  || ports     > free.ports)     errors.push(`Ports must be 1–${free.ports}`);
  if (databases < 0  || databases > free.databases) errors.push(`Databases must be 0–${free.databases}`);
  if (backups   < 0  || backups   > free.backups)   errors.push(`Backups must be 0–${free.backups}`);

  if (errors.length) {
    return res.redirect('/servers/create?error=' + encodeURIComponent(errors.join('. ')));
  }

  // ── Node state enforcement ────────────────────────────────────────────────
  const nodeRow = db.prepare('SELECT * FROM nodes WHERE panel_node_id=?').get(nodeId);
  if (nodeRow) {
    if (nodeRow.state === 'down') {
      return res.redirect('/servers/create?error=' + encodeURIComponent('That node is currently down. Please select a different node.'));
    }
    if (nodeRow.state === 'full') {
      return res.redirect('/servers/create?error=' + encodeURIComponent('That node is full. Please select a different node.'));
    }
    if (nodeRow.state === 'premium') {
      // Only paid-plan users (servers with subscription_active) — check if they have any paid server
      const hasPaid = db.prepare(`SELECT 1 FROM servers WHERE user_id=? AND plan!='free' AND subscription_active=1 LIMIT 1`).get(req.user.id);
      if (!hasPaid) {
        return res.redirect('/servers/create?error=' + encodeURIComponent('That node is for Premium subscribers only. Upgrade at /billing.'));
      }
    }
    // Capacity check
    if (nodeRow.max_servers > 0 && nodeRow.server_count >= nodeRow.max_servers) {
      return res.redirect('/servers/create?error=' + encodeURIComponent('That node is full. Please select a different node.'));
    }
  }

  const s   = settingsObj();
  const dashUrl = s.dashboard_url || process.env.BASE_URL || 'http://localhost:3000';
  const description = `Managed by ${dashUrl}`;

  let renewalDue = null;
  if (s.renewal_enabled === '1') {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(s.renewal_days || '30', 10));
    renewalDue = d.toISOString();
  }

  // Consume resources immediately (reserved while queued or deploying)
  consumeResources(req.user.id, { memory, disk, cpu, ports, databases, backups });

  const payload = {
    name, description, nestId, eggId, nodeId,
    plan: 'free',
    specs: { memory, disk, cpu, ports, databases, backups },
    subscription_active: 0, subscription_gateway: null,
    billing_cycle_start: null, billing_cycle_end: null,
  };

  // ── Premium node → skip queue, create immediately ─────────────────────────
  if (nodeRow && nodeRow.state === 'premium') {
    const result = await createServerImmediate(req.user.id, payload);
    if (result.ok) {
      return res.redirect('/dashboard?success=' + encodeURIComponent('Server created instantly!'));
    } else {
      return res.redirect('/servers/create?error=' + encodeURIComponent('Server creation failed: ' + result.error));
    }
  }

  const jobId = enqueue(req.user.id, payload);
  res.redirect('/dashboard?success=' + encodeURIComponent('Server queued! It will be ready in a moment. Job #' + jobId));
});

// ─────────────────────────────────────────────────────────────────────────────
// Edit / Delete Server
// ─────────────────────────────────────────────────────────────────────────────
app.get('/servers/:id/edit', ensureAuth, (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });
  res.render('servers/edit', { user: req.user, server, error: req.query.error||null, pageTitle: 'Edit Server' });
});

app.post('/servers/:id/edit', ensureAuth, async (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });
  const newName = (req.body.name || server.name).slice(0, 60);
  try {
    await ptero.api.patch(`/servers/${server.pterodactyl_server_id}/details`, {
      name: newName, user: req.user.pterodactyl_user_id
    });
    db.prepare('UPDATE servers SET name=? WHERE id=?').run(newName, server.id);
    res.redirect('/dashboard?success=' + encodeURIComponent('Server renamed.'));
  } catch (err) {
    res.redirect(`/servers/${req.params.id}/edit?error=` + encodeURIComponent('Rename failed.'));
  }
});

app.get('/servers/:id/delete', ensureAuth, (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });
  let blockReason = null;
  if (server.plan !== 'free' && server.subscription_active === 1) {
    const end = server.billing_cycle_end ? new Date(server.billing_cycle_end) : null;
    if (end && end > new Date()) {
      blockReason = `Active subscription — cannot delete until ${end.toLocaleDateString('en-IN', { day:'numeric',month:'long',year:'numeric' })}.`;
    }
  }
  res.render('servers/delete', { user: req.user, server, blockReason, pageTitle: 'Delete Server' });
});

app.post('/servers/:id/delete', ensureAuth, async (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });
  if (server.plan !== 'free' && server.subscription_active === 1) {
    const end = server.billing_cycle_end ? new Date(server.billing_cycle_end) : null;
    if (end && end > new Date()) return res.redirect('/dashboard?error=' + encodeURIComponent('Cannot delete server with active subscription.'));
  }
  try {
    await ptero.deleteServer(server.pterodactyl_server_id, true);
    returnResources(req.user.id, { memory:server.memory, disk:server.disk, cpu:server.cpu, ports:server.ports||1, databases:server.databases||0, backups:server.backups||0 });
    deleteServerRow.run(server.id);
    res.redirect('/dashboard?success=' + encodeURIComponent('Server deleted. Resources returned to your pool.'));
  } catch (err) {
    console.error(err.response?.data||err.message);
    res.redirect('/dashboard?error=' + encodeURIComponent('Failed to delete server.'));
  }
});

app.post('/servers/:id/cancel-subscription', ensureAuth, (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });
  db.prepare('UPDATE servers SET subscription_active=2 WHERE id=?').run(server.id);
  const end = server.billing_cycle_end ? new Date(server.billing_cycle_end).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'}) : 'end of cycle';
  res.redirect('/account?success=' + encodeURIComponent(`Subscription cancelled. Server stays active until ${end}.`));
});

// ── Server renewal (coin-based) ────────────────────────────
app.post('/servers/:id/renew', ensureAuth, async (req, res) => {
  const server = getServerById.get(req.params.id);
  if (!server || server.user_id !== req.user.id) return res.status(404).render('error', { message: 'Not found.' });

  const s = settingsObj();
  if (s.renewal_enabled !== '1') return res.redirect('/dashboard?error=' + encodeURIComponent('Renewal is not enabled.'));

  const price = parseInt(s.renewal_price || '5', 10);
  const days  = parseInt(s.renewal_days  || '30', 10);
  const user  = getUser.get(req.user.id);

  if (user.coins < price) {
    return res.redirect('/dashboard?error=' + encodeURIComponent(`Not enough coins. You need ${price} coins to renew. You have ${user.coins}.`));
  }

  // Deduct coins and extend renewal_due
  addCoins(req.user.id, -price, 'server_renewal', `server:${server.id}`);
  const newDue = new Date();
  newDue.setDate(newDue.getDate() + days);
  db.prepare('UPDATE servers SET renewal_due=?, renewal_suspended=0 WHERE id=?').run(newDue.toISOString(), server.id);

  // Unsuspend on panel if it was suspended
  if (server.renewal_suspended === 1) {
    try {
      await ptero.api.post(`/servers/${server.pterodactyl_server_id}/unsuspend`);
    } catch (err) {
      console.error('Unsuspend failed:', err.response?.data || err.message);
    }
  }

  res.redirect('/dashboard?success=' + encodeURIComponent(`Server renewed for ${days} days!`));
});

// ── Renewal cron — call via POST /internal/process-renewals ──
// Run this from cron: curl -sX POST http://localhost:3000/internal/process-renewals
// Or set up a cron job: */30 * * * * curl -sX POST http://localhost:3000/internal/process-renewals
app.post('/internal/process-renewals', async (req, res) => {
  const s = settingsObj();
  if (s.renewal_enabled !== '1') return res.json({ skipped: true, reason: 'renewal disabled' });

  const graceDays = parseInt(s.renewal_grace_days || '1', 10);
  const now = new Date();
  const results = [];

  // Servers where renewal_due has passed and not yet suspended
  const overdue = db.prepare(`
    SELECT * FROM servers
    WHERE renewal_due IS NOT NULL
      AND renewal_due < ?
      AND renewal_suspended = 0
  `).all(now.toISOString());

  for (const server of overdue) {
    const dueDate = new Date(server.renewal_due);
    const daysPast = Math.floor((now - dueDate) / 86400000);

    if (daysPast >= graceDays) {
      // Grace period expired — delete the server
      try {
        await ptero.deleteServer(server.pterodactyl_server_id, true);
        returnResources(server.user_id, {
          memory: server.memory, disk: server.disk, cpu: server.cpu,
          ports: server.ports || 1, databases: server.databases || 0, backups: server.backups || 0
        });
        deleteServerRow.run(server.id);
        results.push({ id: server.id, action: 'deleted', reason: 'grace_expired' });

        // Notify via coin log so user sees it
        addCoins(server.user_id, 0, 'server_deleted_no_renewal', `server:${server.id}:${server.name}`);
      } catch (err) {
        results.push({ id: server.id, action: 'delete_failed', error: err.message });
      }
    } else {
      // Within grace period — suspend
      try {
        await ptero.api.post(`/servers/${server.pterodactyl_server_id}/suspend`);
        db.prepare('UPDATE servers SET renewal_suspended=1 WHERE id=?').run(server.id);
        results.push({ id: server.id, action: 'suspended', days_overdue: daysPast });
      } catch (err) {
        results.push({ id: server.id, action: 'suspend_failed', error: err.message });
      }
    }
  }

  res.json({ processed: results.length, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store  /store
// ─────────────────────────────────────────────────────────────────────────────
app.get('/store', ensureAuth, (req, res) => {
  const items = getStoreItems.all();
  res.render('store/index', {
    user: req.user, items, pageTitle: 'Store',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.post('/store/buy/:key', ensureAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM store_items WHERE key=? AND active=1').get(req.params.key);
  if (!item) return res.redirect('/store?error=' + encodeURIComponent('Item not found.'));

  const qty  = Math.min(Math.max(parseInt(req.body.qty, 10) || 1, 1), 100); // clamp 1-100
  const total = item.cost * qty;

  const user = getUser.get(req.user.id);
  if (user.coins < total) {
    return res.redirect('/store?error=' + encodeURIComponent(`Not enough coins. You have ${user.coins}, need ${total} (${qty}x).`));
  }

  addCoins(req.user.id, -total, 'store_purchase', `${item.key}x${qty}`);

  const grant = item.amount * qty;
  if (item.resource === 'memory')    db.prepare('UPDATE users SET res_memory=res_memory+?       WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'disk')      db.prepare('UPDATE users SET res_disk=res_disk+?           WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'cpu')       db.prepare('UPDATE users SET res_cpu=res_cpu+?             WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'ports')     db.prepare('UPDATE users SET res_ports=res_ports+?         WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'databases') db.prepare('UPDATE users SET res_databases=res_databases+? WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'backups')   db.prepare('UPDATE users SET res_backups=res_backups+?     WHERE id=?').run(grant, req.user.id);
  if (item.resource === 'coins')     addCoins(req.user.id, grant, 'store_coins', `${item.key}x${qty}`);

  res.redirect('/store?success=' + encodeURIComponent(`Purchased ${qty}x ${item.name}!`));
});

// ─────────────────────────────────────────────────────────────────────────────
// Earn Coins  /earn
// ─────────────────────────────────────────────────────────────────────────────
app.get('/earn', ensureAuth, (req, res) => {
  const s = settingsObj();
  const user = getUser.get(req.user.id);

  const lastDaily = user.last_daily_claim ? new Date(user.last_daily_claim) : null;
  const now = new Date();
  const canClaimDaily = !lastDaily || (now - lastDaily) >= 24 * 3600_000;
  const dailyNextIn = lastDaily ? Math.max(0, 24*3600 - Math.floor((now-lastDaily)/1000)) : 0;

  const recentLog = db.prepare('SELECT * FROM coin_log WHERE user_id=? ORDER BY id DESC LIMIT 15').all(req.user.id);

  // Build apis object — only pass sections that are configured
  const apis = {
    workink:      s.workink_offer_id    ? { offerId: s.workink_offer_id }                                          : null,
    paymentwall:  s.paymentwall_app_key ? { appKey: s.paymentwall_app_key, widget: s.paymentwall_widget || 'mw6' } : null,
    notik:        s.notik_api_key       ? { apiKey: s.notik_api_key, offerUrl: s.notik_offer_url }                 : null,
  };

  res.render('earn/index', {
    user: req.user,
    canClaimDaily, dailyNextIn,
    dailyCoins:    parseInt(s.daily_coins    || '50', 10),
    workinkCoins:  parseInt(s.workink_coins  || '20', 10),
    notikCoins:    parseInt(s.notik_coins    || '25', 10),
    apis, recentLog, pageTitle: 'Earn Coins',
    error:   req.query.error  || null,
    success: req.query.success || null
  });
});

// Daily claim
app.post('/earn/daily', ensureAuth, (req, res) => {
  const user     = getUser.get(req.user.id);
  const s        = settingsObj();
  const amt      = parseInt(s.daily_coins||'50', 10);
  const lastDaily= user.last_daily_claim ? new Date(user.last_daily_claim) : null;
  const now      = new Date();

  if (lastDaily && (now - lastDaily) < 24*3600_000) {
    const wait = Math.ceil((24*3600_000 - (now-lastDaily)) / 3600_000);
    return res.redirect('/earn?error=' + encodeURIComponent(`Already claimed! Come back in ${wait}h.`));
  }

  addCoins(req.user.id, amt, 'daily', null);
  db.prepare('UPDATE users SET last_daily_claim=? WHERE id=?').run(nowISO(), req.user.id);
  res.redirect('/earn?success=' + encodeURIComponent(`+${amt} coins claimed!`));
});

// Work.ink verification callback — user completes offer, Work.ink pings our endpoint
// Docs: https://work.ink/developers  — set postback URL to /earn/workink/callback
app.get('/earn/workink/callback', async (req, res) => {
  const { user_id, offer_id, payout, secret } = req.query;
  const s = settingsObj();

  // Validate secret matches our API key (Work.ink sends it as a param)
  if (!s.workink_api_key || secret !== s.workink_api_key) {
    return res.status(403).send('Invalid secret');
  }

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!user) return res.status(404).send('User not found');

  // Deduplicate: check if this payout ref was already processed
  const already = db.prepare("SELECT id FROM coin_log WHERE reason='workink' AND ref=?").get(offer_id+':'+payout);
  if (already) return res.send('Already processed');

  const amt = parseInt(s.workink_coins||'20', 10);
  addCoins(user_id, amt, 'workink', `${offer_id}:${payout}`);
  db.prepare('UPDATE users SET last_workink_claim=? WHERE id=?').run(nowISO(), user_id);
  res.send('OK');
});

// Work.ink link redirect
app.get('/earn/workink', ensureAuth, (req, res) => {
  const s = settingsObj();
  if (!s.workink_offer_id) return res.redirect('/earn?error=' + encodeURIComponent('Work.ink not configured.'));
  res.redirect(`https://work.ink/${s.workink_offer_id}?user_id=${encodeURIComponent(req.user.id)}`);
});

// Notik link redirect — https://notik.me developer docs
app.get('/earn/notik', ensureAuth, (req, res) => {
  const s = settingsObj();
  if (!s.notik_api_key) return res.redirect('/earn?error=' + encodeURIComponent('Notik not configured.'));
  const url = s.notik_offer_url
    ? `${s.notik_offer_url}&user_id=${encodeURIComponent(req.user.id)}`
    : `https://notik.me/offers?api_key=${s.notik_api_key}&user_id=${encodeURIComponent(req.user.id)}`;
  res.redirect(url);
});

// Notik postback — set postback URL in Notik dashboard to:
// https://yourdomain.com/earn/notik/callback?user_id={user_id}&offer_id={offer_id}&payout={payout}&secret={YOUR_SECRET_KEY}
app.get('/earn/notik/callback', async (req, res) => {
  const { user_id, offer_id, payout, secret } = req.query;
  const s = settingsObj();
  if (!s.notik_secret_key || secret !== s.notik_secret_key) return res.status(403).send('Invalid secret');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!user) return res.status(404).send('User not found');
  const ref = `notik:${offer_id}:${payout}`;
  const already = db.prepare("SELECT id FROM coin_log WHERE reason='notik' AND ref=?").get(ref);
  if (already) return res.send('Already processed');
  const amt = parseInt(s.notik_coins || '25', 10);
  addCoins(user_id, amt, 'notik', ref);
  res.send('OK');
});

// Paymentwall pingback — set pingback URL in Paymentwall dashboard to:
// https://yourdomain.com/earn/paymentwall/callback
// Paymentwall sends: uid, currency, type, ref, sign, sign_version
app.get('/earn/paymentwall/callback', async (req, res) => {
  const crypto = require('crypto');
  const { uid, currency, type, ref, sign, sign_version } = req.query;
  const s = settingsObj();
  if (!s.paymentwall_secret_key) return res.status(403).send('Not configured');

  // Verify Paymentwall signature (sign_version=2: md5 of sorted params + secret)
  const params = Object.entries(req.query)
    .filter(([k]) => k !== 'sign')
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join('&');
  const expected = crypto.createHash('md5').update(params + s.paymentwall_secret_key).digest('hex');
  if (sign !== expected) return res.status(403).send('Invalid signature');

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!user) return res.status(404).send('User not found');

  const already = db.prepare("SELECT id FROM coin_log WHERE reason='paymentwall' AND ref=?").get(ref);
  if (already) return res.send('OK'); // idempotent

  const amt = parseInt(s.paymentwall_coins || '30', 10);
  addCoins(uid, amt, 'paymentwall', ref);
  res.send('OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// Account Settings
// ─────────────────────────────────────────────────────────────────────────────
app.get('/account', ensureAuth, (req, res) => {
  const servers = getServersByUser.all(req.user.id);
  const txns    = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  const coinLog = db.prepare('SELECT * FROM coin_log WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.render('account/index', {
    user: req.user, servers, txns, coinLog, pageTitle: 'Account',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.get('/account/reset-password', ensureAuth, (req, res) => {
  res.render('account/reset-password', { user: req.user, newPassword: null, error: req.query.error||null, pageTitle: 'Reset Password' });
});

app.post('/account/reset-password', ensureAuth, async (req, res) => {
  if (!req.user.pterodactyl_user_id) {
    return res.render('account/reset-password', { user: req.user, newPassword: null, error: 'Account not linked to panel.' });
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = Array.from({length:16}, () => chars[Math.floor(Math.random()*chars.length)]).join('') + 'A1!';
  try {
    await ptero.api.patch(`/users/${req.user.pterodactyl_user_id}`, {
      email: req.user.email,
      username: (req.user.username||'user').replace(/[^a-zA-Z0-9_]/g,'').slice(0,32)||'user',
      first_name: req.user.username||'User', last_name: 'User', password: pw
    });
    res.render('account/reset-password', { user: req.user, newPassword: pw, error: null, pageTitle: 'Reset Password' });
  } catch (err) {
    console.error(err.response?.data||err.message);
    res.render('account/reset-password', { user: req.user, newPassword: null, error: 'Failed to reset password.', pageTitle: 'Reset Password' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout / Payments
// ─────────────────────────────────────────────────────────────────────────────
app.get('/checkout/:planKey', ensureAuth, async (req, res) => {
  const plan = getPlanByKey.get(req.params.planKey);
  if (!plan) return res.redirect('/dashboard?error=Plan+not+found.');
  if (!req.user.pterodactyl_user_id) return res.redirect('/dashboard?error=Account+not+linked+to+panel.');
  const gateway = req.query.gateway === 'paypal' ? 'paypal' : 'razorpay';
  try {
    const [rawNests, nodes] = await Promise.all([ptero.listNestsWithEggs(), ptero.listNodes()]);
    const nests = filterNestsByAllowedEggs(rawNests);
    res.render('checkout/configure', { user: req.user, plan, gateway, nests, nodes, error: req.query.error||null, pageTitle: 'Checkout' });
  } catch (err) {
    res.redirect('/dashboard?error=' + encodeURIComponent('Could not load panel options.'));
  }
});

app.post('/checkout/:planKey/pay', ensureAuth, async (req, res) => {
  const plan    = getPlanByKey.get(req.params.planKey);
  if (!plan) return res.redirect('/dashboard?error=Plan+not+found.');
  const gateway = req.body.gateway === 'paypal' ? 'paypal' : 'razorpay';
  const nestId  = parseInt(req.body.nest_id,10);
  const eggId   = parseInt(req.body.egg_id, 10);
  const nodeId  = parseInt(req.body.node_id,10);
  const name    = (req.body.name || `${req.user.username}'s ${plan.name} Server`).slice(0,60);
  if (!nestId||!eggId||!nodeId) return res.redirect(`/checkout/${plan.key}?gateway=${gateway}&error=Select+software+and+node.`);
  const deployConfig = JSON.stringify({ nest_id:nestId, egg_id:eggId, node_id:nodeId, name });
  try {
    if (gateway === 'razorpay') {
      const order = await payments.createRazorpayOrder({
        amountPaise: plan.price_inr,
        receipt: `plan_${plan.key}_${req.user.id}_${Date.now()}`,
        notes: { user_id: req.user.id, plan_key: plan.key }
      });
      insertTransaction.run({ user_id:req.user.id, plan_key:plan.key, gateway:'razorpay', gateway_order_id:order.id, amount:plan.price_inr/100, currency:'INR', type:'new', deploy_config:deployConfig });
      return res.render('checkout/razorpay', { user:req.user, plan, order, keyId:process.env.RAZORPAY_KEY_ID, baseUrl:process.env.BASE_URL||'', pageTitle: 'Pay' });
    }
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const order   = await payments.createPaypalOrder({ amountUsd:plan.price_usd, referenceId:`plan_${plan.key}_${req.user.id}`, returnUrl:`${baseUrl}/checkout/paypal/return`, cancelUrl:`${baseUrl}/checkout/${plan.key}?gateway=paypal` });
    insertTransaction.run({ user_id:req.user.id, plan_key:plan.key, gateway:'paypal', gateway_order_id:order.id, amount:plan.price_usd, currency:'USD', type:'new', deploy_config:deployConfig });
    const approveLink = order.links.find(l=>l.rel==='approve')?.href;
    if (!approveLink) throw new Error('No PayPal approval link.');
    res.redirect(approveLink);
  } catch (err) {
    console.error(err.response?.data||err.message);
    res.redirect(`/checkout/${plan.key}?gateway=${gateway}&error=Payment+failed.+Try+again.`);
  }
});

async function fulfillPaidTransaction(tx) {
  const plan = db.prepare('SELECT * FROM plans WHERE key=?').get(tx.plan_key);
  if (!plan) throw new Error('Unknown plan');
  const cfg  = JSON.parse(tx.deploy_config||'{}');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(tx.user_id);
  const s    = settingsObj();
  const specs = { memory:plan.memory, disk:plan.disk, cpu:plan.cpu, databases:plan.databases, backups:plan.backups, ports:plan.ports || 1 };
  const desc  = `Managed by ${s.dashboard_url||process.env.BASE_URL||'http://localhost:3000'}`;
  const result = await ptero.createServer({ panelUserId:user.pterodactyl_user_id, name:cfg.name, nestId:cfg.nest_id, eggId:cfg.egg_id, nodeId:cfg.node_id, specs, description:desc });
  const now = nowISO(), next = nextBillingDate();
  insertServer.run({
    user_id:user.id, pterodactyl_server_id:result.attributes.id, pterodactyl_identifier:result.attributes.identifier,
    name:cfg.name, description:desc, plan:plan.key, egg_id:cfg.egg_id, nest_id:cfg.nest_id, node_id:cfg.node_id,
    ...specs, subscription_active:1, subscription_gateway:tx.gateway, billing_cycle_start:now, billing_cycle_end:next
  });
  return db.prepare('SELECT * FROM servers WHERE pterodactyl_server_id=?').get(result.attributes.id);
}

app.post('/checkout/razorpay/verify', ensureAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!payments.verifyRazorpayPaymentSignature({ orderId:razorpay_order_id, paymentId:razorpay_payment_id, signature:razorpay_signature }))
    return res.status(400).json({ ok:false, error:'Invalid signature.' });
  const tx = getTransactionByOrderId.get(razorpay_order_id,'razorpay');
  if (!tx||tx.user_id!==req.user.id) return res.status(404).json({ ok:false, error:'Transaction not found.' });
  if (tx.status==='paid') return res.json({ ok:true, redirect:'/dashboard?success=Already+processed.' });
  try {
    const server = await fulfillPaidTransaction(tx);
    markTransactionPaid.run(razorpay_payment_id, server.id, tx.id);
    res.json({ ok:true, redirect:'/dashboard?success=' + encodeURIComponent('Payment successful!') });
  } catch(err) {
    console.error(err.response?.data||err.message);
    res.status(500).json({ ok:false, error:'Server creation failed. Contact support. Order: '+razorpay_order_id });
  }
});

app.post('/webhooks/razorpay', async (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  if (!sig || !payments.verifyRazorpayWebhookSignature({ rawBody:req.body, signature:sig })) return res.status(400).send('Invalid');
  let payload; try { payload=JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }
  if (payload.event==='payment.captured') {
    const orderId=payload.payload?.payment?.entity?.order_id, paymentId=payload.payload?.payment?.entity?.id;
    const tx=getTransactionByOrderId.get(orderId,'razorpay');
    if (tx&&tx.status!=='paid') { try { const s=await fulfillPaidTransaction(tx); markTransactionPaid.run(paymentId,s.id,tx.id); } catch(e){console.error(e.message);} }
  }
  res.json({ received:true });
});

app.get('/checkout/paypal/return', ensureAuth, async (req, res) => {
  const orderId=req.query.token;
  if (!orderId) return res.redirect('/dashboard?error=Missing+PayPal+reference.');
  const tx=getTransactionByOrderId.get(orderId,'paypal');
  if (!tx||tx.user_id!==req.user.id) return res.redirect('/dashboard?error=Transaction+not+found.');
  if (tx.status==='paid') return res.redirect('/dashboard?success=Already+processed.');
  try {
    const capture=await payments.capturePaypalOrder(orderId);
    if (capture.status!=='COMPLETED') { markTransactionFailed.run(tx.id); return res.redirect('/dashboard?error=Payment+not+completed.'); }
    const captureId=capture.purchase_units?.[0]?.payments?.captures?.[0]?.id||orderId;
    const server=await fulfillPaidTransaction(tx);
    markTransactionPaid.run(captureId,server.id,tx.id);
    res.redirect('/dashboard?success=' + encodeURIComponent('Payment successful!'));
  } catch(err) {
    console.error(err.response?.data||err.message);
    res.redirect('/dashboard?error=' + encodeURIComponent('Server creation failed. Contact support: '+orderId));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Panel
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', ensureAdmin, (req, res) => {
  const userCount    = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const serverCount  = db.prepare('SELECT COUNT(*) as n FROM servers').get().n;
  const paidTxnCount = db.prepare(`SELECT COUNT(*) as n FROM transactions WHERE status='paid'`).get().n;
  res.render('admin/index', {
    user:req.user, settings:settingsObj(), pageTitle: 'Admin',
    userCount, serverCount, paidTxnCount,
    error:req.query.error||null, success:req.query.success||null
  });
});

app.post('/admin/settings/defaults', ensureAdmin, (req, res) => {
  const fields = [
    'default_memory','default_disk','default_cpu','default_ports','default_databases','default_backups',
    'daily_coins','workink_coins','workink_api_key','workink_offer_id',
    'paymentwall_app_key','paymentwall_secret_key','paymentwall_widget','paymentwall_coins',
    'notik_api_key','notik_secret_key','notik_coins','notik_offer_url',
    'dashboard_url','app_name','app_favicon_url',
    'renewal_enabled','renewal_price','renewal_days','renewal_grace_days',
    'queue_enabled','queue_delay_seconds','queue_max_parallel'
  ];
  for (const f of fields) if (req.body[f] !== undefined) setSetting(f, req.body[f]);
  // Checkbox: explicitly persist on/off (absent body field = unchecked)
  setSetting('hide_credit', req.body.hide_credit === '1' ? '1' : '0');
  const statToggles = [
    'stat_show_users','stat_show_servers','stat_show_paid_transactions',
    'stat_show_free_servers','stat_show_paid_servers','stat_show_admins','stat_show_revenue'
  ];
  for (const t of statToggles) setSetting(t, req.body[t] === '1' ? '1' : '0');
  audit(req.user, 'settings.update', { type:'settings', id:'global', name:'Settings' }, { fields: fields.filter(f => req.body[f] !== undefined) }, req.ip);
  const dest = req.body.redirect === '/admin/apis' ? '/admin/apis' : '/admin';
  res.redirect(dest + '?success=Settings+updated.');
});

// Dedicated /admin/apis page
app.get('/admin/apis', ensureAdmin, (req, res) => {
  res.render('admin/apis', {
    user: req.user, settings: settingsObj(), pageTitle: 'Admin — Earn APIs',
    error: req.query.error||null, success: req.query.success||null
  });
});

// Dedicated /admin/servers page
app.get('/admin/servers', ensureAdmin, (req, res) => {
  res.render('admin/servers', {
    user: req.user, servers: getAllServersAdmin.all(), pageTitle: 'Admin — Servers',
    error: req.query.error||null, success: req.query.success||null
  });
});

// Dedicated /admin/users page
app.get('/admin/users', ensureAdmin, (req, res) => {
  res.render('admin/users', {
    user: req.user, users: getAllUsers.all(), pageTitle: 'Admin — Users',
    error: req.query.error||null, success: req.query.success||null
  });
});

// Dedicated /admin/transactions page
app.get('/admin/transactions', ensureAdmin, (req, res) => {
  const txns = db.prepare(`SELECT t.*,u.username,u.email FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.id DESC LIMIT 50`).all();
  res.render('admin/transactions', {
    user: req.user, transactions: txns, pageTitle: 'Admin — Transactions',
    error: req.query.error||null, success: req.query.success||null
  });
});

// Dedicated /admin/eggs page
app.get('/admin/eggs', ensureAdmin, (req, res) => {
  res.render('admin/eggs', {
    user: req.user, eggs: db.prepare('SELECT * FROM eggs ORDER BY nest_name, egg_name').all(),
    pageTitle: 'Admin — Eggs',
    error: req.query.error||null, success: req.query.success||null
  });
});


app.post('/admin/servers/:id/specs', ensureAdmin, async (req, res) => {
  const server=getServerById.get(req.params.id);
  if (!server) return res.redirect('/admin/servers?error=Not+found.');
  const specs={
    memory:parseInt(req.body.memory,10), disk:parseInt(req.body.disk,10), cpu:parseInt(req.body.cpu,10),
    ports:Math.max(1, parseInt(req.body.ports,10) || server.ports || 1),
    databases:parseInt(req.body.databases,10), backups:parseInt(req.body.backups,10)
  };
  try {
    await ptero.updateServerBuild(server.pterodactyl_server_id, specs);
    db.prepare('UPDATE servers SET memory=?,disk=?,cpu=?,ports=?,databases=?,backups=? WHERE id=?').run(specs.memory,specs.disk,specs.cpu,specs.ports,specs.databases,specs.backups,server.id);
    audit(req.user, 'server.update_specs', { type:'server', id:server.id, name:server.name }, { before:{memory:server.memory,disk:server.disk,cpu:server.cpu,ports:server.ports}, after:specs }, req.ip);
    res.redirect('/admin/servers?success=Specs+updated.');
  } catch(err) { res.redirect('/admin/servers?error=Failed+to+update+specs.'); }
});

app.post('/admin/servers/:id/delete', ensureAdmin, async (req, res) => {
  const server=getServerById.get(req.params.id);
  if (!server) return res.redirect('/admin/servers?error=Not+found.');
  try {
    await ptero.deleteServer(server.pterodactyl_server_id, true);
    returnResources(server.user_id, { memory:server.memory, disk:server.disk, cpu:server.cpu, ports:server.ports||1, databases:server.databases||0, backups:server.backups||0 });
    deleteServerRow.run(server.id);
    audit(req.user, 'server.delete', { type:'server', id:server.id, name:server.name }, { plan:server.plan, user_id:server.user_id }, req.ip);
    res.redirect('/admin/servers?success=Server+deleted.');
  } catch(err) { res.redirect('/admin/servers?error=Failed+to+delete.'); }
});

app.post('/admin/users/:id/toggle-admin', ensureAdmin, (req, res) => {
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/admin/users?error=Not+found.');
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(u.is_admin?0:1,u.id);
  audit(req.user, u.is_admin ? 'user.revoke_admin' : 'user.grant_admin', { type:'user', id:u.id, name:u.username }, {}, req.ip);
  res.redirect('/admin/users?success=User+updated.');
});

app.post('/admin/users/:id/gift-coins', ensureAdmin, (req, res) => {
  const amt=parseInt(req.body.amount,10)||0;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/admin/users?error=Not+found.');
  addCoins(req.params.id, amt, 'admin_gift', req.user.id);
  audit(req.user, 'user.gift_coins', { type:'user', id:u.id, name:u.username }, { amount:amt }, req.ip);
  res.redirect('/admin/users?success=' + encodeURIComponent(`Gifted ${amt} coins to ${u.username}.`));
});

app.post('/admin/users/:id/set-resources', ensureAdmin, (req, res) => {
  const fields=['res_memory','res_disk','res_cpu','res_ports','res_databases','res_backups'];
  const vals=fields.map(f=>parseInt(req.body[f],10)||0);
  db.prepare(`UPDATE users SET res_memory=?,res_disk=?,res_cpu=?,res_ports=?,res_databases=?,res_backups=? WHERE id=?`).run(...vals, req.params.id);
  const uForAudit = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  audit(req.user, 'user.set_resources', { type:'user', id:req.params.id, name:uForAudit?.username }, { memory:vals[0],disk:vals[1],cpu:vals[2],ports:vals[3],databases:vals[4],backups:vals[5] }, req.ip);
  res.redirect('/admin/users?success=Resources+updated.');
});

// ── Admin: Eggs ────────────────────────────────────────────

// Sync eggs from panel into the eggs table
app.post('/admin/eggs/sync', ensureAdmin, async (req, res) => {
  try {
    const nests = await ptero.listNestsWithEggs();
    const upsert = db.prepare(`
      INSERT INTO eggs (nest_id, egg_id, nest_name, egg_name, active)
      VALUES (@nest_id, @egg_id, @nest_name, @egg_name, 1)
      ON CONFLICT(nest_id, egg_id) DO UPDATE SET nest_name=@nest_name, egg_name=@egg_name
    `);
    let count = 0;
    for (const nest of nests) {
      for (const egg of nest.eggs) {
        upsert.run({ nest_id: nest.id, egg_id: egg.id, nest_name: nest.name, egg_name: egg.name });
        count++;
      }
    }
    audit(req.user, 'eggs.sync', { type:'eggs', id:'all', name:'Egg Sync' }, { count }, req.ip);
    res.redirect('/admin/eggs?success=' + encodeURIComponent(`Synced ${count} eggs from panel.`));
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect('/admin/eggs?error=' + encodeURIComponent('Failed to sync eggs from panel.'));
  }
});

// Add a new egg manually
app.post('/admin/eggs/add', ensureAdmin, (req, res) => {
  const { nest_id, egg_id, nest_name, egg_name, description } = req.body;
  if (!nest_id || !egg_id || !egg_name) {
    return res.redirect('/admin/eggs?error=' + encodeURIComponent('Nest ID, Egg ID and name are required.'));
  }
  try {
    db.prepare(`INSERT OR IGNORE INTO eggs (nest_id, egg_id, nest_name, egg_name, description, active)
      VALUES (?,?,?,?,?,1)`).run(parseInt(nest_id), parseInt(egg_id), nest_name||'', egg_name, description||'');
    audit(req.user, 'eggs.add', { type:'egg', id:`${nest_id}:${egg_id}`, name:egg_name }, {}, req.ip);
    res.redirect('/admin/eggs?success=' + encodeURIComponent(`Added egg: ${egg_name}`));
  } catch {
    res.redirect('/admin/eggs?error=' + encodeURIComponent('Egg already exists.'));
  }
});

// Update egg (name, description, active)
app.post('/admin/eggs/:id', ensureAdmin, (req, res) => {
  const { egg_name, nest_name, description, active } = req.body;
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.redirect('/admin/eggs?error=Egg+not+found.');
  db.prepare('UPDATE eggs SET egg_name=?, nest_name=?, description=?, active=? WHERE id=?')
    .run(egg_name, nest_name||'', description||'', active ? 1 : 0, req.params.id);
  audit(req.user, active ? 'eggs.enable' : 'eggs.disable', { type:'egg', id:req.params.id, name:egg_name }, {}, req.ip);
  res.redirect('/admin/eggs?success=' + encodeURIComponent(`Updated egg: ${egg_name}`));
});

// Delete egg
app.post('/admin/eggs/:id/delete', ensureAdmin, (req, res) => {
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.redirect('/admin/eggs?error=Egg+not+found.');
  db.prepare('DELETE FROM eggs WHERE id=?').run(req.params.id);
  audit(req.user, 'eggs.delete', { type:'egg', id:req.params.id, name:egg.egg_name }, {}, req.ip);
  res.redirect('/admin/eggs?success=' + encodeURIComponent(`Deleted egg: ${egg.egg_name}`));
});

// ── Admin: Plans ────────────────────────────────────────────────────────────

// Only replaces the ports value when the submitted value genuinely parses to
// a valid integer >= 1. Anything else (blank, non-numeric, 0, negative) keeps
// whatever was already stored instead of silently collapsing it to 1.
function resolvePorts(raw, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return n;
  const fb = parseInt(fallback, 10);
  return Number.isFinite(fb) && fb >= 1 ? fb : 1;
}

// Admin enters plain rupees (e.g. 200 for ₹200); DB/Razorpay need paise (smallest unit).
// Converts on the way in; views divide by 100 on the way out (unchanged).
function rupeesToPaise(raw, fallback = 0) {
  const n = parseFloat(raw);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 100);
  const fb = parseFloat(fallback);
  return Number.isFinite(fb) && fb >= 0 ? Math.round(fb) : 0;
}

app.post('/admin/plans/create', ensureAdmin, (req, res) => {
  const {key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports}=req.body;
  if (!key||!name) return res.redirect('/admin/plans?error=Key+and+name+are+required.');
  try {
    db.prepare(`INSERT INTO plans (key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .run(key, name, rupeesToPaise(price_inr, 0), parseFloat(price_usd)||0,
          parseInt(memory,10)||0, parseInt(disk,10)||0, parseInt(cpu,10)||0,
          parseInt(databases,10)||1, parseInt(backups,10)||1, resolvePorts(ports, 1));
    audit(req.user, 'plan.create', { type:'plan', id:key, name }, {}, req.ip);
    res.redirect('/admin/plans?success=' + encodeURIComponent(`Plan "${name}" created.`));
  } catch { res.redirect('/admin/plans?error=Plan+key+already+exists.'); }
});

app.post('/admin/plans/:key/update', ensureAdmin, (req, res) => {
  const {name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,active}=req.body;
  const existing = db.prepare('SELECT ports, price_inr FROM plans WHERE key=?').get(req.params.key);
  db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,active=? WHERE key=?`)
    .run(name,rupeesToPaise(price_inr, existing?.price_inr),parseFloat(price_usd),parseInt(memory,10),parseInt(disk,10),parseInt(cpu,10),parseInt(databases,10),parseInt(backups,10),resolvePorts(ports, existing?.ports),active?1:0,req.params.key);
  audit(req.user, 'plan.update', { type:'plan', id:req.params.key, name }, {}, req.ip);
  res.redirect('/admin/plans?success=Plan+updated.');
});

// Bulk-save every plan row at once from the admin Plans tab ("Save Changes" button)
// NOTE: must be registered before the "/admin/plans/:key" wildcard route below,
// otherwise Express matches ":key" against the literal string "bulk-update" first.
app.post('/admin/plans/bulk-update', ensureAdmin, (req, res) => {
  const rows = req.body.plans || {};
  const keys = Object.keys(rows);
  if (!keys.length) return res.redirect('/admin/plans?error=No+plans+to+save.');
  const existingPlans = new Map(
    db.prepare(`SELECT key, ports, price_inr FROM plans WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys)
      .map(p => [p.key, p])
  );
  const stmt = db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,active=? WHERE key=?`);
  const saveAll = db.transaction((rows) => {
    for (const key of Object.keys(rows)) {
      const r = rows[key];
      const existing = existingPlans.get(key);
      stmt.run(
        r.name, rupeesToPaise(r.price_inr, existing?.price_inr), parseFloat(r.price_usd)||0,
        parseInt(r.memory,10)||0, parseInt(r.disk,10)||0, parseInt(r.cpu,10)||0,
        parseInt(r.databases,10)||0, parseInt(r.backups,10)||0, resolvePorts(r.ports, existing?.ports),
        r.active ? 1 : 0, key
      );
    }
  });
  saveAll(rows);
  audit(req.user, 'plan.bulk_update', { type:'plan', id:'bulk', name:'Plans' }, { keys }, req.ip);
  res.redirect('/admin/plans?success=' + encodeURIComponent(`Saved ${keys.length} plan(s).`));
});

// Legacy route kept for backwards compat
app.post('/admin/plans/:key', ensureAdmin, (req, res) => {
  const {name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,active}=req.body;
  const existing = db.prepare('SELECT ports, price_inr FROM plans WHERE key=?').get(req.params.key);
  db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,active=? WHERE key=?`)
    .run(name,rupeesToPaise(price_inr, existing?.price_inr),parseFloat(price_usd),parseInt(memory,10),parseInt(disk,10),parseInt(cpu,10),parseInt(databases,10),parseInt(backups,10),resolvePorts(ports, existing?.ports),active?1:0,req.params.key);
  audit(req.user, 'plan.update', { type:'plan', id:req.params.key, name }, {}, req.ip);
  res.redirect('/admin/plans?success=Plan+updated.');
});

app.post('/admin/plans/:key/delete', ensureAdmin, (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE key=?').get(req.params.key);
  if (!plan) return res.redirect('/admin/plans?error=Plan+not+found.');
  const inUse = db.prepare(`SELECT COUNT(*) as n FROM servers WHERE plan=? AND subscription_active=1`).get(req.params.key).n;
  if (inUse > 0) return res.redirect('/admin/plans?error=' + encodeURIComponent(`Cannot delete: ${inUse} active subscription(s) use this plan.`));
  db.prepare('DELETE FROM plans WHERE key=?').run(req.params.key);
  audit(req.user, 'plan.delete', { type:'plan', id:req.params.key, name:plan.name }, {}, req.ip);
  res.redirect('/admin/plans?success=' + encodeURIComponent(`Plan "${plan.name}" deleted.`));
});

// Dedicated /admin/plans page
app.get('/admin/plans', ensureAdmin, (req, res) => {
  res.render('admin/plans', {
    user: req.user,
    plans: db.prepare('SELECT * FROM plans').all(),
    pageTitle: 'Admin — Plans',
    error: req.query.error||null, success: req.query.success||null
  });
});

// ── Admin: Themes ────────────────────────────────────────────────────────────

const themeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, themes.assetDir(req.params.slug)); }
      catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      const safeField = file.fieldname.replace(/[^a-z0-9]/gi, '');
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/gi, '');
      cb(null, `${safeField}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okImage = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/.test(file.mimetype);
    const okFont  = /^font\/|application\/(font-woff|x-font-ttf|octet-stream)/.test(file.mimetype) || /\.(woff2?|ttf|otf)$/i.test(file.originalname);
    cb(null, okImage || okFont);
  },
});

app.get('/admin/themes', ensureAdmin, (req, res) => {
  res.render('admin/themes', {
    user: req.user,
    themeList: themes.listThemes(),
    activeSlug: themes.getActiveSlug(),
    pageTitle: 'Admin — Themes',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.get('/admin/themes/:slug/edit', ensureAdmin, (req, res) => {
  const theme = themes.loadTheme(req.params.slug);
  if (!theme) return res.redirect('/admin/themes?error=Theme+not+found.');
  if (theme.preset) return res.redirect('/admin/themes?error=' + encodeURIComponent('Presets are read-only — duplicate it first to customize.'));
  res.render('admin/theme-edit', {
    user: req.user,
    theme,
    pageTitle: 'Admin — Edit Theme',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.post('/admin/themes/create', ensureAdmin, (req, res) => {
  const { name, cloneFrom } = req.body;
  if (!name) return res.redirect('/admin/themes?error=Name+is+required.');
  try {
    const slug = themes.createTheme({ name, cloneFrom });
    audit(req.user, 'theme.create', { type:'theme', id:slug, name }, {}, req.ip);
    res.redirect(`/admin/themes/${slug}/edit?success=` + encodeURIComponent(`Theme "${name}" created. Customize it below.`));
  } catch (e) {
    res.redirect('/admin/themes?error=' + encodeURIComponent(e.message));
  }
});

app.post('/admin/themes/:slug/update', ensureAdmin, (req, res) => {
  const b = req.body;
  try {
    const updates = {
      name: b.name,
      palette: {
        pageBackground: b.pageBackground, bodyText: b.bodyText,
        neutral: { '950': b.n950, '900': b.n900, '800': b.n800, '700': b.n700, '600': b.n600, '500': b.n500, '400': b.n400, '300': b.n300 },
        accent:  { '300': b.a300, '400': b.a400, '500': b.a500, '600': b.a600 },
      },
      typography: {
        fontFamily: b.fontFamily, googleFontUrl: b.googleFontUrl || null, baseFontSize: b.baseFontSize,
      },
      layout: {
        radiusScale: parseFloat(b.radiusScale) || 1,
        cardShadow: b.cardShadow,
      },
      animations: {
        enabled: b.animEnabled === 'on', speed: b.animSpeed || '0.18s', style: b.animStyle || 'fade',
        cardHover: b.cardHover === 'on', buttonTransition: b.buttonTransition === 'on',
      },
      customCss: b.customCss || '',
    };
    themes.saveTheme(req.params.slug, updates);
    audit(req.user, 'theme.update', { type:'theme', id:req.params.slug, name:b.name }, {}, req.ip);
    res.redirect(`/admin/themes/${req.params.slug}/edit?success=Theme+saved.`);
  } catch (e) {
    res.redirect(`/admin/themes/${req.params.slug}/edit?error=` + encodeURIComponent(e.message));
  }
});

app.post('/admin/themes/:slug/upload', ensureAdmin, (req, res) => {
  themeUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'loginBackground', maxCount: 1 }, { name: 'bodyBackground', maxCount: 1 }, { name: 'customFont', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.redirect(`/admin/themes/${req.params.slug}/edit?error=` + encodeURIComponent(err.message));
    const slug = req.params.slug;
    const images = { ...themes.loadTheme(slug)?.images };
    const typography = { ...themes.loadTheme(slug)?.typography };
    if (req.files?.logo?.[0])           images.logoUrl             = themes.assetUrl(slug, req.files.logo[0].filename);
    if (req.files?.loginBackground?.[0]) images.loginBackgroundUrl = themes.assetUrl(slug, req.files.loginBackground[0].filename);
    if (req.files?.bodyBackground?.[0])  images.bodyBackgroundUrl  = themes.assetUrl(slug, req.files.bodyBackground[0].filename);
    if (req.files?.customFont?.[0]) {
      typography.customFontUrl = themes.assetUrl(slug, req.files.customFont[0].filename);
      typography.fontSource = 'custom';
      typography.fontFamily = "'FDCustomFont', system-ui, sans-serif";
    }
    try {
      themes.saveTheme(slug, { images, typography });
      res.redirect(`/admin/themes/${slug}/edit?success=Uploaded.`);
    } catch (e) {
      res.redirect(`/admin/themes/${slug}/edit?error=` + encodeURIComponent(e.message));
    }
  });
});

app.post('/admin/themes/:slug/activate', ensureAdmin, (req, res) => {
  try {
    themes.setActiveSlug(req.params.slug);
    audit(req.user, 'theme.activate', { type:'theme', id:req.params.slug, name:req.params.slug }, {}, req.ip);
    res.redirect('/admin/themes?success=' + encodeURIComponent(`Theme activated.`));
  } catch (e) {
    res.redirect('/admin/themes?error=' + encodeURIComponent(e.message));
  }
});

app.post('/admin/themes/:slug/delete', ensureAdmin, (req, res) => {
  try {
    themes.deleteTheme(req.params.slug);
    audit(req.user, 'theme.delete', { type:'theme', id:req.params.slug, name:req.params.slug }, {}, req.ip);
    res.redirect('/admin/themes?success=Theme+deleted.');
  } catch (e) {
    res.redirect('/admin/themes?error=' + encodeURIComponent(e.message));
  }
});

// ── Admin: Store ────────────────────────────────────────────────────────────

app.get('/admin/store', ensureAdmin, (req, res) => {
  res.render('admin/store', {
    user: req.user,
    storeItems: getAllStoreItems.all(),
    pageTitle: 'Admin — Store',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.post('/admin/store/new', ensureAdmin, (req, res) => {
  const {key,name,description,resource,amount,cost}=req.body;
  if (!key||!name||!resource) return res.redirect('/admin/store?error=Missing+fields.');
  try {
    db.prepare(`INSERT INTO store_items(key,name,description,resource,amount,cost,active) VALUES(?,?,?,?,?,?,1)`)
      .run(key,name,description||'',resource,parseInt(amount,10)||0,parseInt(cost,10)||0);
    audit(req.user, 'store.create_item', { type:'store_item', id:key, name }, { resource, amount, cost }, req.ip);
    res.redirect('/admin/store?success=Store+item+created.');
  } catch { res.redirect('/admin/store?error=Key+already+exists.'); }
});

app.post('/admin/store/:key/update', ensureAdmin, (req, res) => {
  const {name,description,resource,amount,cost,active}=req.body;
  db.prepare(`UPDATE store_items SET name=?,description=?,resource=?,amount=?,cost=?,active=? WHERE key=?`)
    .run(name,description,resource,parseInt(amount,10),parseInt(cost,10),active?1:0,req.params.key);
  audit(req.user, 'store.update_item', { type:'store_item', id:req.params.key, name }, {}, req.ip);
  res.redirect('/admin/store?success=Store+item+updated.');
});

// Legacy compat
app.post('/admin/store/:key', ensureAdmin, (req, res) => {
  const {name,description,resource,amount,cost,active}=req.body;
  db.prepare(`UPDATE store_items SET name=?,description=?,resource=?,amount=?,cost=?,active=? WHERE key=?`)
    .run(name,description,resource,parseInt(amount,10),parseInt(cost,10),active?1:0,req.params.key);
  audit(req.user, 'store.update_item', { type:'store_item', id:req.params.key, name }, {}, req.ip);
  res.redirect('/admin/store?success=Store+item+updated.');
});

// Bulk-save every store item row at once from the admin Store tab ("Save Changes" button)
app.post('/admin/store/bulk-update', ensureAdmin, (req, res) => {
  const rows = req.body.items || {};
  const keys = Object.keys(rows);
  if (!keys.length) return res.redirect('/admin/store?error=No+items+to+save.');
  const stmt = db.prepare(`UPDATE store_items SET name=?,description=?,resource=?,amount=?,cost=?,active=? WHERE key=?`);
  const saveAll = db.transaction((rows) => {
    for (const key of Object.keys(rows)) {
      const r = rows[key];
      stmt.run(r.name, r.description||'', r.resource, parseInt(r.amount,10)||0, parseInt(r.cost,10)||0, r.active ? 1 : 0, key);
    }
  });
  saveAll(rows);
  audit(req.user, 'store.bulk_update', { type:'store_item', id:'bulk', name:'Store Items' }, { keys }, req.ip);
  res.redirect('/admin/store?success=' + encodeURIComponent(`Saved ${keys.length} item(s).`));
});

app.post('/admin/store/:key/delete', ensureAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM store_items WHERE key=?').get(req.params.key);
  if (!item) return res.redirect('/admin/store?error=Item+not+found.');
  db.prepare('DELETE FROM store_items WHERE key=?').run(req.params.key);
  audit(req.user, 'store.delete_item', { type:'store_item', id:req.params.key, name:item.name }, {}, req.ip);
  res.redirect('/admin/store?success=' + encodeURIComponent(`"${item.name}" deleted.`));
});

// ── Admin: Nodes ─────────────────────────────────────────────────────────────

app.get('/admin/nodes', ensureAdmin, async (req, res) => {
  // Sync panel node list then merge with local overrides
  let panelNodes = [];
  try { panelNodes = await ptero.listNodes(); } catch {}

  // Upsert all panel nodes into local table (preserves state/max_servers)
  const upsertNode = db.prepare(`
    INSERT INTO nodes (panel_node_id, name, fqdn, server_count)
    VALUES (@id, @name, @fqdn, @count)
    ON CONFLICT(panel_node_id) DO UPDATE SET name=@name, fqdn=@fqdn, server_count=@count, updated_at=datetime('now')
  `);
  for (const pn of panelNodes) {
    const count = db.prepare('SELECT COUNT(*) as n FROM servers WHERE node_id=?').get(pn.id)?.n || 0;
    upsertNode.run({ id: pn.id, name: pn.name, fqdn: pn.fqdn, count });
  }

  const nodes = db.prepare('SELECT * FROM nodes ORDER BY panel_node_id').all();
  res.render('admin/nodes', {
    user: req.user, nodes, pageTitle: 'Admin — Nodes',
    error: req.query.error||null, success: req.query.success||null
  });
});

app.post('/admin/nodes/update-all', ensureAdmin, (req, res) => {
  const validStates = ['active', 'full', 'down', 'premium'];
  const nodeIds = (req.body.node_ids || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
  if (!nodeIds.length) return res.redirect('/admin/nodes?error=No+nodes+to+update.');

  const updateStmt = db.prepare(`UPDATE nodes SET state=?, max_servers=?, updated_at=datetime('now') WHERE panel_node_id=?`);
  let updated = 0;
  const applyAll = db.transaction(() => {
    for (const nodeId of nodeIds) {
      const state      = req.body['state_' + nodeId];
      const maxServers = parseInt(req.body['max_servers_' + nodeId], 10) || 0;
      if (!validStates.includes(state)) continue;

      const node = db.prepare('SELECT * FROM nodes WHERE panel_node_id=?').get(nodeId);
      if (!node) continue;

      updateStmt.run(state, maxServers, nodeId);
      audit(req.user, 'node.update', { type:'node', id:String(nodeId), name:node.name }, { state, max_servers:maxServers }, req.ip);
      updated++;
    }
  });
  applyAll();

  res.redirect('/admin/nodes?success=' + encodeURIComponent(`Updated ${updated} node(s).`));
});

// Queue status for the current user (called via JS polling on dashboard)
app.get('/api/queue', ensureAuth, (req, res) => {
  const jobs  = getUserQueueStatus(req.user.id);
  const info  = getQueueInfo();
  const jobsWithPos = jobs.map(j => ({
    ...j,
    position: j.status === 'pending' ? getPositionForJob(j.id) : null,
  }));
  res.json({ jobs: jobsWithPos, info });
});

// Admin: audit log with filtering
app.get('/admin/audit', ensureAdmin, (req, res) => {
  const { action, admin, from, to, page: rawPage } = req.query;
  const page    = Math.max(1, parseInt(rawPage || '1', 10));
  const perPage = 50;
  const offset  = (page - 1) * perPage;

  let where = '1=1';
  const params = [];
  if (action) { where += ' AND action LIKE ?';      params.push(`%${action}%`); }
  if (admin)  { where += ' AND admin_name LIKE ?';  params.push(`%${admin}%`); }
  if (from)   { where += ' AND created_at >= ?';    params.push(from); }
  if (to)     { where += ' AND created_at <= ?';    params.push(to + ' 23:59:59'); }

  const total = db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE ${where}`).get(...params).n;
  const logs  = db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
                  .all(...params, perPage, offset);

  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r => r.action);

  res.render('admin/audit', {
    user: req.user, logs, actions,
    filters: { action: action||'', admin: admin||'', from: from||'', to: to||'' },
    pagination: { page, perPage, total, pages: Math.ceil(total / perPage) },
    pageTitle: 'Audit Log',
    error: req.query.error || null
  });
});

// Admin: trigger update check manually
app.post('/admin/update', ensureAdmin, async (req, res) => {
  res.redirect('/admin?success=Update+check+triggered.+Check+server+logs.');
  setTimeout(() => checkForUpdate(), 500);
});

// Suspend expired subscriptions (call from cron)
app.post('/internal/renew-subscriptions', ensureAdmin, async (req, res) => {
  const expired = db.prepare(`SELECT * FROM servers WHERE plan!='free' AND subscription_active=2 AND billing_cycle_end<=datetime('now')`).all();
  for (const s of expired) {
    try { await ptero.api.post(`/servers/${s.pterodactyl_server_id}/suspend`); db.prepare('UPDATE servers SET subscription_active=0 WHERE id=?').run(s.id); } catch {}
  }
  res.json({ suspended: expired.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FusionDash running on port ${PORT}`);
  await firstRunSetup();
  startAutoUpdater();
  startQueue();
  console.log('[queue] Server creation queue started');
});
FUSIONDASH_EOF_SERVER_JS

echo "Writing auto-update.js"
cat > "auto-update.js" << 'FUSIONDASH_EOF_AUTO-UPDATE_JS'
/**
 * auto-update.js
 * Checks https://github.com/lagging-human/FusionDash for new releases/commits.
 * If a newer version is found, pulls the latest changes and restarts via PM2
 * (or plain process.exit so the process manager / nodemon restarts it).
 *
 * Runs on startup and then every AUTOUPDATE_INTERVAL_MINUTES (default 30 min).
 */
const { execSync, exec } = require('child_process');
const axios = require('axios');
const path  = require('path');
const fs    = require('fs');

const REPO_API   = 'https://api.github.com/repos/lagging-human/FusionDash';
const ROOT       = path.resolve(__dirname);
const STAMP_FILE = path.join(ROOT, '.last_update_sha');
const IGNORE_FILE = path.join(ROOT, '.fusionignore');
const BACKUP_DIR  = path.join(require('os').tmpdir(), 'fusiondash-update-backup');
const INTERVAL   = parseInt(process.env.AUTOUPDATE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const ENABLED    = process.env.AUTO_UPDATE !== 'false';

function log(msg) { console.log(`[AutoUpdate] ${msg}`); }

// ── .fusionignore: paths that must survive `git reset --hard` untouched ─────
function readIgnoreList() {
  try {
    return fs.readFileSync(IGNORE_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

function backupIgnoredPaths() {
  const list = readIgnoreList();
  if (!list.length) return [];
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  const kept = [];
  for (const rel of list) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(BACKUP_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    kept.push(rel);
  }
  return kept;
}

function restoreIgnoredPaths(list) {
  for (const rel of list) {
    const src = path.join(BACKUP_DIR, rel);
    const dest = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function readLocalSha() {
  try { return fs.readFileSync(STAMP_FILE, 'utf8').trim(); } catch { return null; }
}

function writeLocalSha(sha) {
  fs.writeFileSync(STAMP_FILE, sha, 'utf8');
}

function getGitHeadSha() {
  try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; }
}

async function getLatestCommitSha() {
  const res = await axios.get(`${REPO_API}/commits/main`, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'FusionDash-Updater' }
  });
  return res.data.sha;
}

async function getLatestRelease() {
  try {
    const res = await axios.get(`${REPO_API}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'FusionDash-Updater' }
    });
    return res.data.tag_name || null;
  } catch { return null; }
}

function pullAndRestart() {
  log('Pulling latest changes…');
  try {
    const protectedPaths = backupIgnoredPaths();
    if (protectedPaths.length) log(`Protecting from .fusionignore: ${protectedPaths.join(', ')}`);

    execSync('git fetch --all && git reset --hard origin/main', { cwd: ROOT, stdio: 'inherit' });

    if (protectedPaths.length) {
      restoreIgnoredPaths(protectedPaths);
      log('Restored protected paths.');
    }

    execSync('npm install --production', { cwd: ROOT, stdio: 'inherit' });
    log('Update complete. Restarting…');

    // Write the new sha so we don't re-update on the next check
    const newSha = getGitHeadSha();
    if (newSha) writeLocalSha(newSha);

    // Prefer PM2 restart if available
    exec('pm2 restart fusiondash 2>/dev/null || pm2 restart all 2>/dev/null', (err) => {
      if (err) {
        log('PM2 not available, using process.exit(0) — ensure a process manager restarts the app.');
        process.exit(0);
      }
    });
  } catch (err) {
    log(`Update failed: ${err.message}`);
  }
}

async function checkForUpdate() {
  if (!ENABLED) return;
  try {
    const remoteSha  = await getLatestCommitSha();
    const localSha   = readLocalSha() || getGitHeadSha();
    const latestTag  = await getLatestRelease();

    if (latestTag) log(`Latest release: ${latestTag}`);
    log(`Remote SHA: ${remoteSha?.slice(0, 7)} | Local SHA: ${localSha?.slice(0, 7)}`);

    if (!remoteSha) return;
    if (localSha === remoteSha) { log('Already up to date.'); return; }

    log(`New version detected (${remoteSha.slice(0, 7)}). Updating…`);
    pullAndRestart();
  } catch (err) {
    log(`Update check failed: ${err.message}`);
  }
}

function startAutoUpdater() {
  if (!ENABLED) { log('Auto-update disabled (AUTO_UPDATE=false).'); return; }
  log(`Auto-updater started. Checking every ${INTERVAL / 60000} min.`);
  // Initial check after 10 seconds (let server finish booting first)
  setTimeout(checkForUpdate, 10_000);
  setInterval(checkForUpdate, INTERVAL);
}

module.exports = { startAutoUpdater, checkForUpdate };
FUSIONDASH_EOF_AUTO-UPDATE_JS

echo "Writing icons.js"
cat > "icons.js" << 'FUSIONDASH_EOF_ICONS_JS'
'use strict';

// SVG icon map — strings only, no template literals or special chars that trip EJS
const ICONS = {
  coin:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M14.25 7.5c-.69-.414-1.58-.75-2.25-.75-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2c-.67 0-1.56-.336-2.25-.75M12 6v1.5m0 9V18"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"/></svg>',
  link:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>',
  card:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 21Z"/></svg>',
  bolt:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"/></svg>',
  box:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/></svg>',
  plug:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>',
  disk:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m0 5.625c0 2.278 3.694 4.125 8.25 4.125s8.25-1.847 8.25-4.125"/></svg>',
  cpu:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z"/></svg>',
  plus:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>',
  gift:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"/></svg>',
  globe:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418"/></svg>',
  cart:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>',
  users:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"/></svg>',
  list:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg>',
  money:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
  server:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 17.25v.75a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25v-.75m19.5 0A2.25 2.25 0 0 0 21.75 15V9a2.25 2.25 0 0 0-2.25-2.25h-15A2.25 2.25 0 0 0 2.25 9v6a2.25 2.25 0 0 0 2.25 2.25m19.5 0h-19.5M12 12h.008v.008H12V12Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>',
  refresh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>',
  memory:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122"/></svg>',
  key:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z"/></svg>',
  user:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>',
  logout:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"/></svg>',
  home:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"/></svg>',
  warning:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>',
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
  trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>',
  edit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/></svg>',
  palette:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a8.25 8.25 0 0 1-2.883-15.98A8.25 8.25 0 0 1 21 9.75c0 1.243-1.007 2.25-2.25 2.25h-1.83a1.62 1.62 0 0 0-1.17 2.744c.3.311.483.734.483 1.2 0 .995-.897 1.759-1.874 1.552A8.279 8.279 0 0 1 12 21Z"/><circle cx="7.75" cy="11.25" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  image:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75 6 12l3.5 3.5L15 9l6.75 6.75M4.5 19.5h15a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5h-15A1.5 1.5 0 0 0 3 6v12a1.5 1.5 0 0 0 1.5 1.5Z"/><circle cx="8" cy="8.5" r="1.25" fill="currentColor" stroke="none"/></svg>',
};

/**
 * Returns an SVG string with the given classes injected.
 * Usage in EJS: <%- icon('coin', 'h-4 w-4 text-yellow-400') %>
 */
function icon(name, cls) {
  const svg = ICONS[name] || ICONS['settings'];
  cls = cls || 'h-4 w-4';
  return svg.replace('<svg ', '<svg class="' + cls + '" ');
}

module.exports = { icon, ICONS };
FUSIONDASH_EOF_ICONS_JS

echo "Writing themes.js"
cat > "themes.js" << 'FUSIONDASH_EOF_THEMES_JS'
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
FUSIONDASH_EOF_THEMES_JS

echo "Writing package.json"
cat > "package.json" << 'FUSIONDASH_EOF_PACKAGE_JSON'
{
  "name": "pterodactyl-billing-dashboard",
  "version": "1.0.0",
  "main": "server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js",
    "create:user": "node scripts/create-user.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "passport": "^0.7.0",
    "passport-discord": "^0.1.4",
    "passport-google-oauth20": "^2.0.0",
    "dotenv": "^16.4.5",
    "ejs": "^3.1.10",
    "better-sqlite3": "^11.3.0",
    "axios": "^1.7.7",
    "multer": "^1.4.5-lts.1"
  }
}
FUSIONDASH_EOF_PACKAGE_JSON
printf %s "$(cat "package.json")" > "package.json"

echo "Writing .fusionignore"
cat > ".fusionignore" << 'FUSIONDASH_EOF__FUSIONIGNORE'
# Paths listed here (relative to the project root, one per line) are backed up
# before the auto-updater runs `git reset --hard` and restored immediately after,
# so admin customizations under these paths survive updates untouched.
#
# Lines starting with # and blank lines are ignored.

themes/custom/
FUSIONDASH_EOF__FUSIONIGNORE

echo "Writing views/components/admin_tabs.ejs"
cat > "views/components/admin_tabs.ejs" << 'FUSIONDASH_EOF_VIEWS_COMPONENTS_ADMIN_TABS_EJS'
<%
  const _adminTabs = [
    { id:'settings', label:'Settings',     href:'/admin',              iconName:'settings' },
    { id:'apis',     label:'Earn APIs',    href:'/admin/apis',         iconName:'link'     },
    { id:'plans',    label:'Plans',        href:'/admin/plans',        iconName:'money'    },
    { id:'themes',   label:'Themes',       href:'/admin/themes',       iconName:'palette'  },
    { id:'store',    label:'Store Items',  href:'/admin/store',        iconName:'cart'     },
    { id:'nodes',    label:'Nodes',        href:'/admin/nodes',        iconName:'server'   },
    { id:'servers',  label:'Servers',      href:'/admin/servers',      iconName:'server'   },
    { id:'users',    label:'Users',        href:'/admin/users',        iconName:'users'    },
    { id:'txns',     label:'Transactions', href:'/admin/transactions', iconName:'list'     },
    { id:'eggs',     label:'Eggs',         href:'/admin/eggs',         iconName:'database' },
    { id:'audit',    label:'Audit Log',    href:'/admin/audit',        iconName:'refresh'  },
  ];
%>
<div class="sticky top-0 z-10 flex overflow-x-auto gap-x-0.5 px-4 sm:px-6 lg:px-8 bg-[#0c0d0f] border-b border-white/[0.06]">
  <% _adminTabs.forEach(tab => { %>
  <a href="<%= tab.href %>"
    class="tab-btn shrink-0 flex items-center gap-x-1.5 px-4 py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap
      <%= typeof adminTab !== 'undefined' && adminTab === tab.id ? 'border-blue-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-600' %>">
    <%- icon(tab.iconName, 'h-3.5 w-3.5') %> <%= tab.label %>
  </a>
  <% }) %>
</div>
FUSIONDASH_EOF_VIEWS_COMPONENTS_ADMIN_TABS_EJS

echo "Writing views/components/header.ejs"
cat > "views/components/header.ejs" << 'FUSIONDASH_EOF_VIEWS_COMPONENTS_HEADER_EJS'
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><%= typeof pageTitle !== 'undefined' ? pageTitle + ' — ' + appName : appName %></title>
  <% if (appFavicon) { %>
  <link rel="icon" href="<%= appFavicon %>">
  <% } else { %>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231d4ed8'/><text y='.9em' font-size='70' x='15' fill='white'>F</text></svg>">
  <% } %>
  <script src="https://cdn.tailwindcss.com"></script>
  <% if (typeof theme !== 'undefined' && theme.typography.fontSource === 'custom' && theme.typography.customFontUrl) { %>
  <!-- Custom uploaded font: @font-face is emitted in the theme <style> block below -->
  <% } else { %>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="<%= (typeof theme !== 'undefined' && theme.typography.googleFontUrl) || 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap' %>" rel="stylesheet">
  <% } %>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { min-height: 100vh; }
    .app-shell { display: flex; min-height: 100vh; }
    @media (min-width: 1024px) {
      .app-main { margin-left: 256px; width: calc(100% - 256px); }
    }
    @media (max-width: 1023px) {
      .app-main { margin-left: 0; width: 100%; padding-top: 52px; }
    }
    input[type="range"] { accent-color: var(--fd-a400, #60a5fa); }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      background: var(--fd-a500, #3b82f6);
      height: 16px; width: 16px;
      border-radius: 50%;
      cursor: pointer;
    }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    :focus-visible { outline: 2px solid var(--fd-a500, #3b82f6); outline-offset: 2px; }
    .no-scroll::-webkit-scrollbar { width: 4px; }
    .no-scroll::-webkit-scrollbar-track { background: transparent; }
    .no-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
  </style>
  <% if (typeof themeCSS !== 'undefined') { %>
  <!-- Active theme: generated last so it wins the cascade over Tailwind + the structural CSS above -->
  <style><%- themeCSS %></style>
  <% } %>
</head>
FUSIONDASH_EOF_VIEWS_COMPONENTS_HEADER_EJS
printf '%.0s\n' $(seq 1 1) >> "views/components/header.ejs"

echo "Writing views/login.ejs"
cat > "views/login.ejs" << 'FUSIONDASH_EOF_VIEWS_LOGIN_EJS'
<!doctype html>
<html lang="en">
<%- include('./components/header') %>
<body class="flex min-h-screen items-center justify-center <%= (typeof theme !== 'undefined' && theme.images.loginBackgroundUrl) ? 'has-login-bg' : '' %>">
  <div class="flex min-h-full flex-col justify-center py-12 sm:px-6 lg:px-8">
    <div class="sm:mx-auto sm:w-full sm:max-w-md">
      <h2 class="mt-6 text-center text-2xl font-medium leading-9 text-white">Welcome to <%= appName %></h2>
      <h2 class="mt-1 text-center text-sm font-normal text-zinc-500">Sign in to manage your servers.</h2>
    </div>

    <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-[480px]">
      <div class="bg-zinc-600/10 px-6 py-10 border border-white/5 rounded-3xl sm:px-12">

        <% if (error) { %>
        <div class="mb-6 border border-amber-400/10 bg-amber-400/5 rounded-2xl p-4">
          <p class="text-sm text-amber-400 text-center"><%= error %></p>
        </div>
        <% } %>

        <div class="relative mb-8">
          <div class="absolute inset-0 flex items-center" aria-hidden="true">
            <div class="w-full border-t border-white/10"></div>
          </div>
          <div class="relative flex justify-center text-sm font-medium leading-6">
            <span class="bg-[#151619] px-6 text-zinc-400">Choose a login method</span>
          </div>
        </div>

        <div class="space-y-3">
          <a href="/auth/discord" class="flex w-full items-center justify-center gap-x-3 rounded-full bg-[#5865F2]/10 px-6 py-2.5 text-sm font-medium text-[#5865F2] ring-1 ring-inset ring-[#5865F2]/20 hover:bg-[#5865F2]/20 transition">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.033.054a19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            Continue with Discord
          </a>

          <a href="/auth/google" class="flex w-full items-center justify-center gap-x-3 rounded-full bg-zinc-600/10 px-6 py-2.5 text-sm font-medium text-zinc-300 ring-1 ring-inset ring-white/10 hover:bg-zinc-600/20 transition">
            <svg class="h-4 w-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </a>
        </div>
      </div>

      <% if (!hideCredit) { %>
      <p class="mt-6 text-center text-sm text-zinc-600">
        <a href="https://github.com/lagging-human/FusionDash" target="_blank" class="text-zinc-500 hover:text-zinc-300 transition-colors"><%= appName %></a>
      </p>
      <% } %>
    </div>
  </div>
</body>
</html>
FUSIONDASH_EOF_VIEWS_LOGIN_EJS

echo "Writing views/admin/themes.ejs"
cat > "views/admin/themes.ejs" << 'FUSIONDASH_EOF_VIEWS_ADMIN_THEMES_EJS'
<!doctype html>
<html lang="en">
<%- include('../components/header') %>
<body>
<%- include('../components/sidebar', { activePage:'admin' }) %>
<div class="app-main">

  <% if (error) { %>
  <div class="flex gap-x-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 sm:px-6 lg:px-8">
    <svg class="h-5 w-5 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>
    <p class="text-sm text-amber-300"><%= error %></p>
  </div>
  <% } %>
  <% if (success) { %>
  <div class="flex gap-x-3 border-b border-green-500/20 bg-green-500/10 px-4 py-3 sm:px-6 lg:px-8">
    <svg class="h-5 w-5 text-green-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
    <p class="text-sm text-green-300"><%= success %></p>
  </div>
  <% } %>

  <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8 border-b border-white/[0.06] bg-white/[0.02]">
    <div>
      <p class="text-xs text-zinc-500"><a href="/admin" class="hover:text-zinc-300 transition-colors">Admin</a> <span class="text-zinc-700">/ Themes</span></p>
      <p class="text-sm font-semibold text-white mt-0.5">Themes</p>
    </div>
    <span class="text-xs text-zinc-600"><%= themeList.length %> theme<%= themeList.length !== 1 ? 's' : '' %></span>
  </div>

  <%- include('../components/admin_tabs', { adminTab: 'themes' }) %>

  <div class="px-4 sm:px-6 lg:px-8 py-6 pb-16 space-y-5">

    <p class="text-xs text-zinc-500 max-w-2xl">
      The active theme applies across the whole site — login, dashboard, billing, checkout, and admin.
      Presets are read-only; duplicate one to customize colors, fonts, layout, animations, images, and raw CSS.
      Custom themes live in <code class="text-zinc-400 bg-zinc-900 rounded px-1">/themes/custom/</code> and are protected from auto-update via <code class="text-zinc-400 bg-zinc-900 rounded px-1">.fusionignore</code>.
    </p>

    <!-- Create new theme -->
    <div class="rounded-2xl border border-blue-500/20 bg-blue-500/5 overflow-hidden">
      <div class="flex items-center gap-x-2 px-5 py-3 border-b border-blue-500/20">
        <%- icon('plus', 'h-4 w-4 text-blue-400') %>
        <p class="text-sm font-semibold text-white">Create New Theme</p>
      </div>
      <form action="/admin/themes/create" method="POST" class="p-5 flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-[180px]">
          <label class="block text-xs text-zinc-500 mb-1">Name</label>
          <input type="text" name="name" placeholder="My Custom Theme" required
            class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
        </div>
        <div class="flex-1 min-w-[180px]">
          <label class="block text-xs text-zinc-500 mb-1">Start from</label>
          <select name="cloneFrom" class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
            <% themeList.forEach(t => { %>
            <option value="<%= t.slug %>"><%= t.name %> <%= t.preset ? '(preset)' : '(custom)' %></option>
            <% }) %>
          </select>
        </div>
        <button type="submit" class="rounded-full bg-blue-500/15 px-5 py-2 text-xs font-semibold text-blue-400 ring-1 ring-inset ring-blue-500/30 hover:bg-blue-500/25 transition-colors">
          Create &amp; Customize
        </button>
      </form>
    </div>

    <!-- Theme list -->
    <div class="card-grid">
      <% themeList.forEach(t => { %>
      <% const full = t.slug; %>
      <div class="rounded-2xl border <%= t.active ? 'border-blue-500/30' : 'border-white/[0.06]' %> overflow-hidden">
        <div class="flex items-center gap-3 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <p class="text-sm font-semibold text-white"><%= t.name %></p>
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium <%= t.preset ? 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20' : 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20' %>">
            <%= t.preset ? 'Preset' : 'Custom' %>
          </span>
          <% if (t.active) { %>
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-400 ring-1 ring-green-500/20">Active</span>
          <% } %>
        </div>
        <div class="p-5">
          <div class="flex gap-1.5 mb-4">
            <div class="h-8 w-8 rounded-lg ring-1 ring-inset ring-white/10" style="background:<%= t.swatches.bg %>"></div>
            <div class="h-8 w-8 rounded-lg ring-1 ring-inset ring-white/10" style="background:<%= t.swatches.panel %>"></div>
            <div class="h-8 w-8 rounded-lg ring-1 ring-inset ring-white/10" style="background:<%= t.swatches.accent %>"></div>
          </div>
          <div class="flex flex-wrap gap-2">
            <% if (!t.active) { %>
            <form action="/admin/themes/<%= full %>/activate" method="POST">
              <button type="submit" class="rounded-full bg-green-500/15 px-4 py-1.5 text-xs font-semibold text-green-400 ring-1 ring-inset ring-green-500/30 hover:bg-green-500/25 transition-colors">Activate</button>
            </form>
            <% } %>
            <% if (!t.preset) { %>
            <a href="/admin/themes/<%= full %>/edit" class="rounded-full bg-zinc-500/10 px-4 py-1.5 text-xs font-semibold text-zinc-300 ring-1 ring-inset ring-zinc-500/20 hover:bg-zinc-500/20 transition-colors">Edit</a>
            <% } %>
            <% if (!t.active && !t.preset) { %>
            <form action="/admin/themes/<%= full %>/delete" method="POST" onsubmit="return confirm('Delete theme &quot;<%= t.name %>&quot;? This cannot be undone.')">
              <button type="submit" class="rounded-full bg-red-500/10 px-4 py-1.5 text-xs font-semibold text-red-400 ring-1 ring-inset ring-red-500/20 hover:bg-red-500/15 transition-colors">Delete</button>
            </form>
            <% } %>
          </div>
        </div>
      </div>
      <% }) %>
    </div>

  </div>
</div>
</body>
</html>
FUSIONDASH_EOF_VIEWS_ADMIN_THEMES_EJS

echo "Writing views/admin/theme-edit.ejs"
cat > "views/admin/theme-edit.ejs" << 'FUSIONDASH_EOF_VIEWS_ADMIN_THEME-EDIT_EJS'
<!doctype html>
<html lang="en">
<%- include('../components/header') %>
<body>
<%- include('../components/sidebar', { activePage:'admin' }) %>
<div class="app-main">

  <% if (error) { %>
  <div class="flex gap-x-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 sm:px-6 lg:px-8">
    <svg class="h-5 w-5 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>
    <p class="text-sm text-amber-300"><%= error %></p>
  </div>
  <% } %>
  <% if (success) { %>
  <div class="flex gap-x-3 border-b border-green-500/20 bg-green-500/10 px-4 py-3 sm:px-6 lg:px-8">
    <svg class="h-5 w-5 text-green-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
    <p class="text-sm text-green-300"><%= success %></p>
  </div>
  <% } %>

  <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8 border-b border-white/[0.06] bg-white/[0.02]">
    <div>
      <p class="text-xs text-zinc-500"><a href="/admin" class="hover:text-zinc-300 transition-colors">Admin</a> <span class="text-zinc-700">/</span> <a href="/admin/themes" class="hover:text-zinc-300 transition-colors">Themes</a> <span class="text-zinc-700">/ <%= theme.name %></span></p>
      <p class="text-sm font-semibold text-white mt-0.5">Edit Theme</p>
    </div>
    <a href="/admin/themes" class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Back to Themes</a>
  </div>

  <div class="px-4 sm:px-6 lg:px-8 py-6 pb-24 space-y-5 max-w-4xl">

    <form action="/admin/themes/<%= theme.slug %>/update" method="POST" class="space-y-5">

      <div>
        <label class="block text-xs text-zinc-500 mb-1">Theme Name</label>
        <input type="text" name="name" value="<%= theme.name %>" required
          class="block w-full max-w-sm rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
      </div>

      <!-- Colors -->
      <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
        <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <%- icon('palette', 'h-4 w-4 text-blue-400') %>
          <p class="text-sm font-semibold text-white">Colors</p>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label class="block text-xs text-zinc-500 mb-1">Page Background</label>
              <input type="color" name="pageBackground" value="<%= theme.palette.pageBackground %>" class="h-9 w-full rounded-lg bg-zinc-900 ring-1 ring-inset ring-zinc-700">
            </div>
            <div>
              <label class="block text-xs text-zinc-500 mb-1">Body Text</label>
              <input type="color" name="bodyText" value="<%= theme.palette.bodyText %>" class="h-9 w-full rounded-lg bg-zinc-900 ring-1 ring-inset ring-zinc-700">
            </div>
          </div>
          <div>
            <p class="text-xs text-zinc-500 mb-2">Neutral scale <span class="text-zinc-700">(950 = darkest panels &rarr; 300 = lightest text)</span></p>
            <div class="grid grid-cols-4 sm:grid-cols-8 gap-2">
              <% ['950','900','800','700','600','500','400','300'].forEach(s => { %>
              <div>
                <label class="block text-[10px] text-zinc-600 mb-1 text-center"><%= s %></label>
                <input type="color" name="n<%= s %>" value="<%= theme.palette.neutral[s] %>" class="h-9 w-full rounded-lg bg-zinc-900 ring-1 ring-inset ring-zinc-700">
              </div>
              <% }) %>
            </div>
          </div>
          <div>
            <p class="text-xs text-zinc-500 mb-2">Accent scale <span class="text-zinc-700">(buttons, links, focus rings)</span></p>
            <div class="grid grid-cols-4 gap-2 max-w-xs">
              <% ['300','400','500','600'].forEach(s => { %>
              <div>
                <label class="block text-[10px] text-zinc-600 mb-1 text-center"><%= s %></label>
                <input type="color" name="a<%= s %>" value="<%= theme.palette.accent[s] %>" class="h-9 w-full rounded-lg bg-zinc-900 ring-1 ring-inset ring-zinc-700">
              </div>
              <% }) %>
            </div>
          </div>
        </div>
      </div>

      <!-- Typography -->
      <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
        <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <%- icon('edit', 'h-4 w-4 text-blue-400') %>
          <p class="text-sm font-semibold text-white">Typography</p>
        </div>
        <div class="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Font Family <span class="text-zinc-700">(CSS value)</span></label>
            <input type="text" name="fontFamily" value="<%= theme.typography.fontFamily %>"
              class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm font-mono">
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Base Font Size</label>
            <input type="text" name="baseFontSize" value="<%= theme.typography.baseFontSize %>"
              class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
          </div>
          <div class="sm:col-span-2">
            <label class="block text-xs text-zinc-500 mb-1">Google Font URL <span class="text-zinc-700">(ignored if a custom font is uploaded below)</span></label>
            <input type="text" name="googleFontUrl" value="<%= theme.typography.googleFontUrl || '' %>" placeholder="https://fonts.googleapis.com/css2?family=..."
              class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm font-mono">
          </div>
        </div>
      </div>

      <!-- Layout -->
      <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
        <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <%- icon('settings', 'h-4 w-4 text-blue-400') %>
          <p class="text-sm font-semibold text-white">Layout</p>
        </div>
        <div class="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Corner Roundness <span class="text-zinc-700" id="radiusVal"><%= theme.layout.radiusScale %>&times;</span></label>
            <input type="range" name="radiusScale" min="0" max="2" step="0.1" value="<%= theme.layout.radiusScale %>"
              oninput="document.getElementById('radiusVal').textContent = this.value + '\u00d7'"
              class="block w-full">
            <p class="text-[10px] text-zinc-700 mt-1">0 = sharp corners, 1 = default, 2 = extra rounded. Pills/avatars are unaffected.</p>
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Card Shadow <span class="text-zinc-700">(CSS box-shadow value)</span></label>
            <input type="text" name="cardShadow" value="<%= theme.layout.cardShadow %>"
              class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm font-mono">
          </div>
        </div>
      </div>

      <!-- Animations -->
      <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
        <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <%- icon('bolt', 'h-4 w-4 text-blue-400') %>
          <p class="text-sm font-semibold text-white">Animations</p>
        </div>
        <div class="p-5 space-y-4">
          <label class="flex items-center gap-x-3 cursor-pointer select-none w-fit">
            <div class="relative">
              <input type="checkbox" name="animEnabled" <%= theme.animations.enabled ? 'checked' : '' %> class="sr-only peer">
              <div class="w-10 h-5 bg-zinc-700 rounded-full peer peer-checked:bg-blue-500 transition-colors"></div>
              <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
            </div>
            <span class="text-sm text-zinc-300">Enable page-load animation</span>
          </label>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg">
            <div>
              <label class="block text-xs text-zinc-500 mb-1">Style</label>
              <select name="animStyle" class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
                <% ['fade','slide','none'].forEach(v => { %>
                <option value="<%= v %>" <%= theme.animations.style===v?'selected':'' %>><%= v %></option>
                <% }) %>
              </select>
            </div>
            <div>
              <label class="block text-xs text-zinc-500 mb-1">Speed</label>
              <select name="animSpeed" class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm">
                <% ['0.1s','0.18s','0.3s','0.5s'].forEach(v => { %>
                <option value="<%= v %>" <%= theme.animations.speed===v?'selected':'' %>><%= v %></option>
                <% }) %>
              </select>
            </div>
          </div>
          <label class="flex items-center gap-x-3 cursor-pointer select-none w-fit">
            <div class="relative">
              <input type="checkbox" name="cardHover" <%= theme.animations.cardHover ? 'checked' : '' %> class="sr-only peer">
              <div class="w-10 h-5 bg-zinc-700 rounded-full peer peer-checked:bg-blue-500 transition-colors"></div>
              <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
            </div>
            <span class="text-sm text-zinc-300">Cards lift on hover</span>
          </label>
          <label class="flex items-center gap-x-3 cursor-pointer select-none w-fit">
            <div class="relative">
              <input type="checkbox" name="buttonTransition" <%= theme.animations.buttonTransition ? 'checked' : '' %> class="sr-only peer">
              <div class="w-10 h-5 bg-zinc-700 rounded-full peer peer-checked:bg-blue-500 transition-colors"></div>
              <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
            </div>
            <span class="text-sm text-zinc-300">Smooth transitions on buttons &amp; inputs</span>
          </label>
        </div>
      </div>

      <!-- Custom CSS -->
      <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
        <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
          <%- icon('edit', 'h-4 w-4 text-blue-400') %>
          <p class="text-sm font-semibold text-white">Custom CSS</p>
        </div>
        <div class="p-5">
          <textarea name="customCss" rows="8" placeholder="/* Applied last — overrides everything above */"
            class="block w-full rounded-lg border-none py-2 pl-3 bg-zinc-900 text-white ring-1 ring-inset ring-zinc-700 focus:ring-blue-400 text-sm font-mono"><%= theme.customCss %></textarea>
        </div>
      </div>

      <button type="submit" class="rounded-full bg-blue-500/15 px-6 py-2.5 text-sm font-semibold text-blue-400 ring-1 ring-inset ring-blue-500/30 hover:bg-blue-500/25 transition-colors">
        Save Theme
      </button>
    </form>

    <!-- Images & custom font (separate multipart form) -->
    <div class="rounded-2xl border border-white/[0.06] overflow-hidden">
      <div class="flex items-center gap-x-2 px-5 py-3 bg-white/[0.02] border-b border-white/[0.06]">
        <%- icon('image', 'h-4 w-4 text-blue-400') %>
        <p class="text-sm font-semibold text-white">Images &amp; Custom Font</p>
      </div>
      <form action="/admin/themes/<%= theme.slug %>/upload" method="POST" enctype="multipart/form-data" class="p-5 space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Logo / Favicon</label>
            <% if (theme.images.logoUrl) { %><img src="<%= theme.images.logoUrl %>" class="h-8 w-8 rounded-lg object-cover mb-2 ring-1 ring-inset ring-white/10"><% } %>
            <input type="file" name="logo" accept="image/*" class="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300">
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Custom Font <span class="text-zinc-700">(.woff2/.woff/.ttf)</span></label>
            <% if (theme.typography.fontSource === 'custom' && theme.typography.customFontUrl) { %><p class="text-[11px] text-green-400 mb-2">Active: uploaded font in use</p><% } %>
            <input type="file" name="customFont" accept=".woff,.woff2,.ttf,.otf" class="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300">
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Login Background</label>
            <% if (theme.images.loginBackgroundUrl) { %><img src="<%= theme.images.loginBackgroundUrl %>" class="h-16 w-full rounded-lg object-cover mb-2 ring-1 ring-inset ring-white/10"><% } %>
            <input type="file" name="loginBackground" accept="image/*" class="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300">
          </div>
          <div>
            <label class="block text-xs text-zinc-500 mb-1">Sitewide Background</label>
            <% if (theme.images.bodyBackgroundUrl) { %><img src="<%= theme.images.bodyBackgroundUrl %>" class="h-16 w-full rounded-lg object-cover mb-2 ring-1 ring-inset ring-white/10"><% } %>
            <input type="file" name="bodyBackground" accept="image/*" class="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300">
          </div>
        </div>
        <button type="submit" class="rounded-full bg-zinc-500/10 px-5 py-2 text-xs font-semibold text-zinc-300 ring-1 ring-inset ring-zinc-500/20 hover:bg-zinc-500/20 transition-colors">
          Upload
        </button>
      </form>
    </div>

  </div>
</div>
</body>
</html>
FUSIONDASH_EOF_VIEWS_ADMIN_THEME-EDIT_EJS

echo "Writing themes/presets/midnight/theme.json"
cat > "themes/presets/midnight/theme.json" << 'FUSIONDASH_EOF_THEMES_PRESETS_MIDNIGHT_THEME_JSON'
{
  "name": "Midnight (Default)",
  "palette": {
    "pageBackground": "#0c0d0f",
    "bodyText": "#e4e4e7",
    "neutral": { "950": "#09090b", "900": "#18181b", "800": "#27272a", "700": "#3f3f46", "600": "#52525b", "500": "#71717a", "400": "#a1a1aa", "300": "#d4d4d8" },
    "accent":  { "300": "#93c5fd", "400": "#60a5fa", "500": "#3b82f6", "600": "#2563eb" }
  },
  "typography": {
    "fontFamily": "'Space Grotesk', system-ui, sans-serif",
    "googleFontUrl": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
    "customFontUrl": null,
    "baseFontSize": "16px"
  },
  "layout": { "radiusScale": 1, "cardShadow": "0 1px 2px rgba(0,0,0,.4)" },
  "animations": { "enabled": true, "speed": "0.18s", "style": "fade", "cardHover": false, "buttonTransition": true },
  "images": { "logoUrl": null, "loginBackgroundUrl": null, "bodyBackgroundUrl": null },
  "customCss": ""
}
FUSIONDASH_EOF_THEMES_PRESETS_MIDNIGHT_THEME_JSON

echo "Writing themes/presets/daylight/theme.json"
cat > "themes/presets/daylight/theme.json" << 'FUSIONDASH_EOF_THEMES_PRESETS_DAYLIGHT_THEME_JSON'
{
  "name": "Daylight",
  "palette": {
    "pageBackground": "#f4f4f5",
    "bodyText": "#18181b",
    "neutral": { "950": "#ffffff", "900": "#fbfbfc", "800": "#f1f1f3", "700": "#e0e0e4", "600": "#c9c9d0", "500": "#6b6b74", "400": "#45454c", "300": "#1f1f23" },
    "accent":  { "300": "#bfdbfe", "400": "#60a5fa", "500": "#2563eb", "600": "#1d4ed8" }
  },
  "typography": {
    "fontFamily": "'Space Grotesk', system-ui, sans-serif",
    "googleFontUrl": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
    "customFontUrl": null,
    "baseFontSize": "16px"
  },
  "layout": { "radiusScale": 1, "cardShadow": "0 1px 3px rgba(0,0,0,.08)" },
  "animations": { "enabled": true, "speed": "0.18s", "style": "fade", "cardHover": false, "buttonTransition": true },
  "images": { "logoUrl": null, "loginBackgroundUrl": null, "bodyBackgroundUrl": null },
  "customCss": ""
}
FUSIONDASH_EOF_THEMES_PRESETS_DAYLIGHT_THEME_JSON

echo "Writing themes/presets/aurora/theme.json"
cat > "themes/presets/aurora/theme.json" << 'FUSIONDASH_EOF_THEMES_PRESETS_AURORA_THEME_JSON'
{
  "name": "Aurora",
  "palette": {
    "pageBackground": "#0a0a12",
    "bodyText": "#e6e6f0",
    "neutral": { "950": "#0a0a12", "900": "#161622", "800": "#232336", "700": "#34344a", "600": "#4a4a63", "500": "#6d6d87", "400": "#9d9db4", "300": "#cfcfe0" },
    "accent":  { "300": "#c4b5fd", "400": "#a78bfa", "500": "#8b5cf6", "600": "#7c3aed" }
  },
  "typography": {
    "fontFamily": "'Sora', system-ui, sans-serif",
    "googleFontUrl": "https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap",
    "customFontUrl": null,
    "baseFontSize": "16px"
  },
  "layout": { "radiusScale": 1.3, "cardShadow": "0 1px 2px rgba(0,0,0,.4)" },
  "animations": { "enabled": true, "speed": "0.22s", "style": "slide", "cardHover": true, "buttonTransition": true },
  "images": { "logoUrl": null, "loginBackgroundUrl": null, "bodyBackgroundUrl": null },
  "customCss": ""
}
FUSIONDASH_EOF_THEMES_PRESETS_AURORA_THEME_JSON

echo "Writing themes/presets/sunset/theme.json"
cat > "themes/presets/sunset/theme.json" << 'FUSIONDASH_EOF_THEMES_PRESETS_SUNSET_THEME_JSON'
{
  "name": "Sunset",
  "palette": {
    "pageBackground": "#120d09",
    "bodyText": "#f1e4d5",
    "neutral": { "950": "#120d09", "900": "#1f1712", "800": "#2e2119", "700": "#453324", "600": "#5c4632", "500": "#8a6e54", "400": "#b89b7c", "300": "#e0cbb0" },
    "accent":  { "300": "#fdba74", "400": "#fb923c", "500": "#f97316", "600": "#ea580c" }
  },
  "typography": {
    "fontFamily": "'Manrope', system-ui, sans-serif",
    "googleFontUrl": "https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap",
    "customFontUrl": null,
    "baseFontSize": "16px"
  },
  "layout": { "radiusScale": 0.8, "cardShadow": "0 1px 2px rgba(0,0,0,.4)" },
  "animations": { "enabled": true, "speed": "0.18s", "style": "fade", "cardHover": false, "buttonTransition": true },
  "images": { "logoUrl": null, "loginBackgroundUrl": null, "bodyBackgroundUrl": null },
  "customCss": ""
}
FUSIONDASH_EOF_THEMES_PRESETS_SUNSET_THEME_JSON

echo "Done. 15 files written."
