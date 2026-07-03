'use strict';

const db    = require('./db');
const ptero = require('./pterodactyl');

// ── State ──────────────────────────────────────────────────────────────────
let processing      = 0;   // current parallel creates in flight
let lastJobFinished = 0;   // epoch ms when the last job finished (for delay enforcement)
let tickTimer       = null;

// ── DB statements ──────────────────────────────────────────────────────────
const getNextJob     = db.prepare(`SELECT * FROM server_queue WHERE status='pending' ORDER BY id ASC LIMIT 1`);
const markProcessing = db.prepare(`UPDATE server_queue SET status='processing', started_at=datetime('now') WHERE id=?`);
const markDone       = db.prepare(`UPDATE server_queue SET status='done', server_id=?, finished_at=datetime('now') WHERE id=?`);
const markFailed     = db.prepare(`UPDATE server_queue SET status='failed', error=?, finished_at=datetime('now') WHERE id=?`);
const getUser        = db.prepare('SELECT * FROM users WHERE id=?');
const insertServer   = db.prepare(`
  INSERT INTO servers
    (user_id,pterodactyl_server_id,pterodactyl_identifier,name,description,plan,
     egg_id,nest_id,node_id,memory,disk,cpu,ports,databases,backups,
     subscription_active,subscription_gateway,billing_cycle_start,billing_cycle_end,
     renewal_due,renewal_suspended)
  VALUES
    (@user_id,@pterodactyl_server_id,@pterodactyl_identifier,@name,@description,@plan,
     @egg_id,@nest_id,@node_id,@memory,@disk,@cpu,@ports,@databases,@backups,
     @subscription_active,@subscription_gateway,@billing_cycle_start,@billing_cycle_end,
     @renewal_due,@renewal_suspended)
`);

// ── Settings helper (re-read from DB each tick so admin changes apply live) ─
function getSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s    = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled:       s.queue_enabled !== '0',
    delayMs:       Math.max(0, parseInt(s.queue_delay_seconds || '120', 10)) * 1000,
    maxParallel:   Math.max(1, parseInt(s.queue_max_parallel  || '1',   10)),
    renewalEnabled:s.renewal_enabled === '1',
    renewalDays:   parseInt(s.renewal_days || '30', 10),
  };
}

// ── Process a single queued job ────────────────────────────────────────────
async function processJob(job) {
  markProcessing.run(job.id);
  let payload;
  try { payload = JSON.parse(job.payload); }
  catch { markFailed.run('Invalid payload JSON', job.id); return; }

  const user = getUser.get(job.user_id);
  if (!user?.pterodactyl_user_id) {
    markFailed.run('User not found or not linked to panel', job.id);
    return;
  }

  try {
    const result = await ptero.createServer({
      panelUserId: user.pterodactyl_user_id,
      name:        payload.name,
      nestId:      payload.nestId,
      eggId:       payload.eggId,
      nodeId:      payload.nodeId,
      specs:       payload.specs,
      description: payload.description,
    });

    const s = getSettings();
    let renewalDue = null;
    if (s.renewalEnabled) {
      const d = new Date();
      d.setDate(d.getDate() + s.renewalDays);
      renewalDue = d.toISOString();
    }

    insertServer.run({
      user_id:               user.id,
      pterodactyl_server_id: result.attributes.id,
      pterodactyl_identifier:result.attributes.identifier,
      name:                  payload.name,
      description:           payload.description,
      plan:                  payload.plan || 'free',
      egg_id:                payload.eggId,
      nest_id:               payload.nestId,
      node_id:               payload.nodeId,
      memory:                payload.specs.memory,
      disk:                  payload.specs.disk,
      cpu:                   payload.specs.cpu,
      ports:                 payload.specs.ports     || 1,
      databases:             payload.specs.databases || 0,
      backups:               payload.specs.backups   || 0,
      subscription_active:   payload.subscription_active   || 0,
      subscription_gateway:  payload.subscription_gateway  || null,
      billing_cycle_start:   payload.billing_cycle_start   || null,
      billing_cycle_end:     payload.billing_cycle_end     || null,
      renewal_due:           renewalDue,
      renewal_suspended:     0,
    });

    const server = db.prepare('SELECT * FROM servers WHERE pterodactyl_server_id=?').get(result.attributes.id);
    markDone.run(server.id, job.id);
    lastJobFinished = Date.now();
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.detail || err.message || 'Unknown error';
    markFailed.run(msg, job.id);
    lastJobFinished = Date.now(); // still update so next job doesn't skip the delay
  }
}

// ── Tick: decide whether to start the next job ─────────────────────────────
async function tick() {
  const s = getSettings();
  if (!s.enabled) return;
  if (processing >= s.maxParallel) return;

  // Enforce delay between jobs
  const elapsed = Date.now() - lastJobFinished;
  if (lastJobFinished > 0 && elapsed < s.delayMs) return;

  // Unstick jobs stuck in 'processing' beyond 2× the delay (minimum 2 min)
  const timeout = Math.max(120, (s.delayMs / 1000) * 2);
  db.prepare(`
    UPDATE server_queue SET status='failed', error='Timed out after ${timeout}s'
    WHERE status='processing'
      AND started_at < datetime('now', '-${timeout} seconds')
  `).run();

  const job = getNextJob.get();
  if (!job) return;

  processing++;
  try {
    await processJob(job);
  } finally {
    processing--;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

function startQueue() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, 3000);
  console.log('[queue] started — polling every 3s');
}

function enqueue(userId, payload) {
  const r = db.prepare(`INSERT INTO server_queue (user_id, payload) VALUES (?, ?)`).run(userId, JSON.stringify(payload));
  return r.lastInsertRowid;
}

function getUserQueueStatus(userId) {
  return db.prepare(`
    SELECT id, status, error, server_id, created_at, started_at, finished_at
    FROM server_queue WHERE user_id=? ORDER BY id DESC LIMIT 10
  `).all(userId);
}

/**
 * Returns rich queue info: position, ETA, active count.
 * ETA = (position * delaySeconds) from now, in minutes.
 */
function getQueueInfo() {
  const s        = getSettings();
  const pending  = db.prepare(`SELECT COUNT(*) as n FROM server_queue WHERE status='pending'`).get().n;
  const active   = db.prepare(`SELECT COUNT(*) as n FROM server_queue WHERE status='processing'`).get().n;
  const delayS   = s.delayMs / 1000;
  const etaS     = pending * delayS;

  // Time until the next slot is free (accounting for delay since last job)
  const elapsed  = lastJobFinished > 0 ? (Date.now() - lastJobFinished) / 1000 : delayS;
  const nextSlotS= Math.max(0, delayS - elapsed);

  return {
    pending,
    active,
    maxParallel:    s.maxParallel,
    delaySeconds:   delayS,
    etaSeconds:     Math.ceil(nextSlotS + Math.max(0, pending - 1) * delayS),
    etaMinutes:     Math.ceil((nextSlotS + Math.max(0, pending - 1) * delayS) / 60),
    queueEnabled:   s.enabled,
  };
}

function getPositionForJob(jobId) {
  return db.prepare(`SELECT COUNT(*) as n FROM server_queue WHERE status='pending' AND id<?`).get(jobId).n + 1;
}

module.exports = { startQueue, enqueue, getUserQueueStatus, getQueueInfo, getPositionForJob };
