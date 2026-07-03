'use strict';

const db = require('./db');

const insert = db.prepare(`
  INSERT INTO audit_log (admin_id, admin_name, action, target_type, target_id, target_name, detail, ip)
  VALUES (@admin_id, @admin_name, @action, @target_type, @target_id, @target_name, @detail, @ip)
`);

/**
 * Write an admin action to the audit log.
 *
 * @param {object} admin   - req.user
 * @param {string} action  - dot-notation action, e.g. 'server.delete'
 * @param {object} target  - { type, id, name }
 * @param {object} detail  - any extra context (before/after, reason, etc.)
 * @param {string} ip      - request IP
 */
function audit(admin, action, target = {}, detail = {}, ip = '') {
  try {
    insert.run({
      admin_id:    admin.id,
      admin_name:  admin.username || admin.email || admin.id,
      action,
      target_type: target.type  || null,
      target_id:   String(target.id   || ''),
      target_name: target.name  || null,
      detail:      Object.keys(detail).length ? JSON.stringify(detail) : null,
      ip:          ip || null,
    });
  } catch (err) {
    // Audit log must never crash the app
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = { audit };
