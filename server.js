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
  res.render('dashboard', {
    user: req.user, servers, plans, free, pageTitle: 'Dashboard',
    error: req.query.error||null, success: req.query.success||null
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create Server
// ─────────────────────────────────────────────────────────────────────────────
app.get('/servers/create', ensureAuth, async (req, res) => {
  if (!req.user.pterodactyl_user_id) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Your account is not linked to the panel yet. Try logging out and back in.'));
  }
  try {
    const [nests, nodes] = await Promise.all([ptero.listNestsWithEggs(), ptero.listNodes()]);
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

  try {
    const specs  = { memory, disk, cpu, databases, backups };
    const result = await ptero.createServer({
      panelUserId: req.user.pterodactyl_user_id, name, nestId, eggId, nodeId, specs, description
    });

    insertServer.run({
      user_id: req.user.id,
      pterodactyl_server_id:  result.attributes.id,
      pterodactyl_identifier: result.attributes.identifier,
      name, description, plan: 'free',
      egg_id: eggId, nest_id: nestId, node_id: nodeId,
      memory, disk, cpu, ports, databases, backups,
      subscription_active: 0, subscription_gateway: null,
      billing_cycle_start: null, billing_cycle_end: null
    });

    consumeResources(req.user.id, { memory, disk, cpu, ports, databases, backups });

    res.redirect('/dashboard?success=' + encodeURIComponent('Server created!'));
  } catch (err) {
    console.error(err.response?.data||err.message);
    const msg = err.response?.data?.errors?.[0]?.detail || err.message || 'Failed to create server.';
    res.redirect('/servers/create?error=' + encodeURIComponent(msg));
  }
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
    const [nests, nodes] = await Promise.all([ptero.listNestsWithEggs(), ptero.listNodes()]);
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
  const specs = { memory:plan.memory, disk:plan.disk, cpu:plan.cpu, databases:plan.databases, backups:plan.backups };
  const desc  = `Managed by ${s.dashboard_url||process.env.BASE_URL||'http://localhost:3000'}`;
  const result = await ptero.createServer({ panelUserId:user.pterodactyl_user_id, name:cfg.name, nestId:cfg.nest_id, eggId:cfg.egg_id, nodeId:cfg.node_id, specs, description:desc });
  const now = nowISO(), next = nextBillingDate();
  insertServer.run({
    user_id:user.id, pterodactyl_server_id:result.attributes.id, pterodactyl_identifier:result.attributes.identifier,
    name:cfg.name, description:desc, plan:plan.key, egg_id:cfg.egg_id, nest_id:cfg.nest_id, node_id:cfg.node_id,
    ...specs, ports:1, subscription_active:1, subscription_gateway:tx.gateway, billing_cycle_start:now, billing_cycle_end:next
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
  const txns = db.prepare(`SELECT t.*,u.username,u.email FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.id DESC LIMIT 50`).all();
  res.render('admin/index', {
    user:req.user, settings:settingsObj(),
    users:getAllUsers.all(), servers:getAllServersAdmin.all(),
    plans:db.prepare('SELECT * FROM plans').all(),
    storeItems:getAllStoreItems.all(), transactions:txns, pageTitle: 'Admin',
    error:req.query.error||null, success:req.query.success||null
  });
});

app.post('/admin/settings/defaults', ensureAdmin, (req, res) => {
  const fields = [
    'default_memory','default_disk','default_cpu','default_ports','default_databases','default_backups',
    'daily_coins','workink_coins','workink_api_key','workink_offer_id',
    'paymentwall_app_key','paymentwall_secret_key','paymentwall_widget','paymentwall_coins',
    'notik_api_key','notik_secret_key','notik_coins','notik_offer_url',
    'dashboard_url','app_name','app_favicon_url'
  ];
  for (const f of fields) if (req.body[f] !== undefined) setSetting(f, req.body[f]);
  res.redirect('/admin?success=Settings+updated.#settings');
});

app.post('/admin/servers/:id/specs', ensureAdmin, async (req, res) => {
  const server=getServerById.get(req.params.id);
  if (!server) return res.redirect('/admin?error=Not+found.');
  const specs={ memory:parseInt(req.body.memory,10), disk:parseInt(req.body.disk,10), cpu:parseInt(req.body.cpu,10), databases:parseInt(req.body.databases,10), backups:parseInt(req.body.backups,10) };
  try {
    await ptero.updateServerBuild(server.pterodactyl_server_id, specs);
    db.prepare('UPDATE servers SET memory=?,disk=?,cpu=?,databases=?,backups=? WHERE id=?').run(specs.memory,specs.disk,specs.cpu,specs.databases,specs.backups,server.id);
    res.redirect('/admin?success=Specs+updated.');
  } catch(err) { res.redirect('/admin?error=Failed+to+update+specs.'); }
});

app.post('/admin/servers/:id/delete', ensureAdmin, async (req, res) => {
  const server=getServerById.get(req.params.id);
  if (!server) return res.redirect('/admin?error=Not+found.');
  try {
    await ptero.deleteServer(server.pterodactyl_server_id, true);
    returnResources(server.user_id, { memory:server.memory, disk:server.disk, cpu:server.cpu, ports:server.ports||1, databases:server.databases||0, backups:server.backups||0 });
    deleteServerRow.run(server.id);
    res.redirect('/admin?success=Server+deleted.');
  } catch(err) { res.redirect('/admin?error=Failed+to+delete.'); }
});

app.post('/admin/users/:id/toggle-admin', ensureAdmin, (req, res) => {
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/admin?error=Not+found.');
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(u.is_admin?0:1,u.id);
  res.redirect('/admin?success=User+updated.');
});

app.post('/admin/users/:id/gift-coins', ensureAdmin, (req, res) => {
  const amt=parseInt(req.body.amount,10)||0;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/admin?error=Not+found.');
  addCoins(req.params.id, amt, 'admin_gift', req.user.id);
  res.redirect('/admin?success=' + encodeURIComponent(`Gifted ${amt} coins to ${u.username}.`));
});

app.post('/admin/users/:id/set-resources', ensureAdmin, (req, res) => {
  const fields=['res_memory','res_disk','res_cpu','res_ports','res_databases','res_backups'];
  const vals=fields.map(f=>parseInt(req.body[f],10)||0);
  db.prepare(`UPDATE users SET res_memory=?,res_disk=?,res_cpu=?,res_ports=?,res_databases=?,res_backups=? WHERE id=?`).run(...vals, req.params.id);
  res.redirect('/admin?success=Resources+updated.');
});

app.post('/admin/plans/:key', ensureAdmin, (req, res) => {
  const {name,price_inr,price_usd,memory,disk,cpu,databases,backups,active}=req.body;
  db.prepare(`UPDATE plans SET name=?,price_inr=?,price_usd=?,memory=?,disk=?,cpu=?,databases=?,backups=?,active=? WHERE key=?`)
    .run(name,parseInt(price_inr,10),parseFloat(price_usd),parseInt(memory,10),parseInt(disk,10),parseInt(cpu,10),parseInt(databases,10),parseInt(backups,10),active?1:0,req.params.key);
  res.redirect('/admin?success=Plan+updated.');
});

app.post('/admin/store/:key', ensureAdmin, (req, res) => {
  const {name,description,resource,amount,cost,active}=req.body;
  db.prepare(`UPDATE store_items SET name=?,description=?,resource=?,amount=?,cost=?,active=? WHERE key=?`)
    .run(name,description,resource,parseInt(amount,10),parseInt(cost,10),active?1:0,req.params.key);
  res.redirect('/admin?success=Store+item+updated.');
});

app.post('/admin/store/new', ensureAdmin, (req, res) => {
  const {key,name,description,resource,amount,cost}=req.body;
  if (!key||!name||!resource) return res.redirect('/admin?error=Missing+fields.');
  try {
    db.prepare(`INSERT INTO store_items(key,name,description,resource,amount,cost,active) VALUES(?,?,?,?,?,?,1)`)
      .run(key,name,description||'',resource,parseInt(amount,10)||0,parseInt(cost,10)||0);
    res.redirect('/admin?success=Store+item+created.');
  } catch { res.redirect('/admin?error=Key+already+exists.'); }
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
app.listen(PORT, () => {
  console.log(`FusionDash running on port ${PORT}`);
  startAutoUpdater();
});
