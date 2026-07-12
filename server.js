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

// External integration API (e.g. a separate storefront/status site pulling
// live plan+node data). Auth is optional: set EXTERNAL_API_KEY in .env to
// require `Authorization: Bearer <key>`; leave unset to keep these open.
// NOTE: unlike the rest of FusionDash's API, these two return bare JSON
// arrays (no {ok,...} wrapper) — that's the shape the consuming site expects.
function checkExternalApiKey(req, res) {
  const configured = process.env.EXTERNAL_API_KEY;
  if (!configured) return true;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== configured) { res.status(401).json({ ok:false, error:'Unauthorized' }); return false; }
  return true;
}

app.get('/api/plans/:type', (req, res) => {
  if (!checkExternalApiKey(req, res)) return;
  // FusionDash only manages Minecraft/Pterodactyl hosting today, so any other
  // requested type genuinely has zero plans rather than falling back to stale data.
  if (req.params.type !== 'minecraft') return res.json([]);
  const rows = db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY price_inr ASC').all();
  const plans = rows.map(p => ({
    slug: p.key,
    name: p.name,
    price: Number(p.price_usd) || 0,   // consumer template does plan.price.toFixed(2)
    period: 'month',                    // FusionDash bills on a flat renewal cycle, no per-plan period yet
    price_inr: p.price_inr,
    price_usd: p.price_usd,
    memory: p.memory,
    disk: p.disk,
    cpu: p.cpu,
    databases: p.databases,
    backups: p.backups,
    ports: p.ports,
    availability: (() => { try { return JSON.parse(p.available_node_ids || '[]'); } catch { return []; } })(),
  }));
  res.json(plans);
});

app.get('/api/nodes', (req, res) => {
  if (!checkExternalApiKey(req, res)) return;
  const rows = db.prepare(`SELECT * FROM nodes WHERE state != 'down' ORDER BY panel_node_id`).all();
  const nodes = rows.map(n => ({
    id: n.panel_node_id,
    name: n.name,
    location: n.location || '',
    ip: n.fqdn,
    port: n.public_port || null,
  }));
  res.json(nodes);
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

// The node-picker checkboxes only submit a name when checked, so "nothing
// checked" is indistinguishable from "the picker section wasn't on the page
// at all" (e.g. the local nodes table was empty on render). The hidden
// `nodesPresent` marker always submits when the section rendered, so we only
// touch available_node_ids when we know that's a real, deliberate selection —
// otherwise we preserve whatever was already stored.
function resolveNodeIds(nodesPresent, rawNodeIds, fallbackJson) {
  if (!nodesPresent) return fallbackJson || '[]';
  const arr = Array.isArray(rawNodeIds) ? rawNodeIds : (rawNodeIds ? [rawNodeIds] : []);
  const ids = arr.map(id => parseInt(id, 10)).filter(Number.isFinite);
  return JSON.stringify(ids);
}

app.post('/admin/plans/create', ensureAdmin, (req, res) => {
  const {key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports}=req.body;
  if (!key||!name) return res.redirect('/admin/plans?error=Key+and+name+are+required.');
  try {
    db.prepare(`INSERT INTO plans (key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,available_node_ids,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(key, name, rupeesToPaise(price_inr, 0), parseFloat(price_usd)||0,
          parseInt(memory,10)||0, parseInt(disk,10)||0, parseInt(cpu,10)||0,
          parseInt(databases,10)||1, parseInt(backups,10)||1, resolvePorts(ports, 1), '[]');
    audit(req.user, 'plan.create', { type:'plan', id:key, name }, {}, req.ip);
    res.redirect('/admin/plans?success=' + encodeURIComponent(`Plan "${name}" created. Pick its available nodes below.`));
  } catch { res.redirect('/admin/plans?error=Plan+key+already+exists.'); }
});

app.post('/admin/plans/:key/update', ensureAdmin, (req, res) => {
  const {name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,active,nodeIds,nodesPresent}=req.body;
  const existing = db.prepare('SELECT ports, price_inr, available_node_ids FROM plans WHERE key=?').get(req.params.key);
  db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,available_node_ids=?,active=? WHERE key=?`)
    .run(name,rupeesToPaise(price_inr, existing?.price_inr),parseFloat(price_usd),parseInt(memory,10),parseInt(disk,10),parseInt(cpu,10),parseInt(databases,10),parseInt(backups,10),resolvePorts(ports, existing?.ports),resolveNodeIds(nodesPresent, nodeIds, existing?.available_node_ids),active?1:0,req.params.key);
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
    db.prepare(`SELECT key, ports, price_inr, available_node_ids FROM plans WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys)
      .map(p => [p.key, p])
  );
  const stmt = db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,available_node_ids=?,active=? WHERE key=?`);
  const saveAll = db.transaction((rows) => {
    for (const key of Object.keys(rows)) {
      const r = rows[key];
      const existing = existingPlans.get(key);
      stmt.run(
        r.name, rupeesToPaise(r.price_inr, existing?.price_inr), parseFloat(r.price_usd)||0,
        parseInt(r.memory,10)||0, parseInt(r.disk,10)||0, parseInt(r.cpu,10)||0,
        parseInt(r.databases,10)||0, parseInt(r.backups,10)||0, resolvePorts(r.ports, existing?.ports),
        resolveNodeIds(r.nodesPresent, r.nodeIds, existing?.available_node_ids),
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
  const {name,price_inr,price_usd,memory,disk,cpu,databases,backups,ports,active,nodeIds,nodesPresent}=req.body;
  const existing = db.prepare('SELECT ports, price_inr, available_node_ids FROM plans WHERE key=?').get(req.params.key);
  db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,ports=?,available_node_ids=?,active=? WHERE key=?`)
    .run(name,rupeesToPaise(price_inr, existing?.price_inr),parseFloat(price_usd),parseInt(memory,10),parseInt(disk,10),parseInt(cpu,10),parseInt(databases,10),parseInt(backups,10),resolvePorts(ports, existing?.ports),resolveNodeIds(nodesPresent, nodeIds, existing?.available_node_ids),active?1:0,req.params.key);
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
    nodes: db.prepare('SELECT * FROM nodes ORDER BY panel_node_id').all(),
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

  const updateStmt = db.prepare(`UPDATE nodes SET state=?, max_servers=?, location=?, public_port=?, updated_at=datetime('now') WHERE panel_node_id=?`);
  let updated = 0;
  const applyAll = db.transaction(() => {
    for (const nodeId of nodeIds) {
      const state      = req.body['state_' + nodeId];
      const maxServers = parseInt(req.body['max_servers_' + nodeId], 10) || 0;
      const location   = (req.body['location_' + nodeId] || '').trim();
      const publicPort = parseInt(req.body['public_port_' + nodeId], 10) || 0;
      if (!validStates.includes(state)) continue;

      const node = db.prepare('SELECT * FROM nodes WHERE panel_node_id=?').get(nodeId);
      if (!node) continue;

      updateStmt.run(state, maxServers, location, publicPort, nodeId);
      audit(req.user, 'node.update', { type:'node', id:String(nodeId), name:node.name }, { state, max_servers:maxServers, location, public_port:publicPort }, req.ip);
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
