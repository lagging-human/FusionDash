require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const passport = require('./passport-config');
const db       = require('./db');
const ptero    = require('./pterodactyl');
const payments = require('./payments');
const { startAutoUpdater, checkForUpdate } = require('./auto-update');
const { icon } = require('./icons');
const { getLiveStats, getOrCreateInstallId } = require('./telemetry');
const { startQueue, enqueue, getUserQueueStatus, getQueueInfo, getPositionForJob } = require('./queue');
const { audit } = require('./audit');
const { firstRunSetup } = require('./first-run');

const app = express();
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));
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
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Public
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('home', { user: req.user, stats: getLiveStats(), pageTitle: 'Home' });
});

app.get('/api/stats', (req, res) => {
  const stats = getLiveStats();
  delete stats.install_id;
  res.json({ ok: true, stats });
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
  const plans   = getAllPlans.all();
  const free    = freeResources(req.user);
  const s       = settingsObj();
  const renewal = {
    enabled:    s.renewal_enabled    === '1',
    price:      parseInt(s.renewal_price    || '5',  10),
    days:       parseInt(s.renewal_days     || '30', 10),
    graceDays:  parseInt(s.renewal_grace_days || '1', 10),
  };
  res.render('dashboard', {
    user: req.user, servers, plans, free, renewal, pageTitle: 'Dashboard',
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

  const s   = settingsObj();
  const dashUrl = s.dashboard_url || process.env.BASE_URL || 'http://localhost:3000';
  const description = `Managed by ${dashUrl}`;

  let renewalDue = null;
  if (s.renewal_enabled === '1') {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(s.renewal_days || '30', 10));
    renewalDue = d.toISOString();
  }

  // Consume resources immediately (reserved while queued)
  consumeResources(req.user.id, { memory, disk, cpu, ports, databases, backups });

  const jobId = enqueue(req.user.id, {
    name, description, nestId, eggId, nodeId,
    plan: 'free',
    specs: { memory, disk, cpu, ports, databases, backups },
    subscription_active: 0, subscription_gateway: null,
    billing_cycle_start: null, billing_cycle_end: null,
  });

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
    const dueDate = new 
