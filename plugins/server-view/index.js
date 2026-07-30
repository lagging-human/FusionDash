'use strict';
/**
 * Server View — example plugin demonstrating addServerCardAction + registerRoute.
 *
 * Scoped deliberately to data FusionDash's own DB already has (server row +
 * its audit trail), plus a link out to the real Pterodactyl panel — NOT an
 * in-app file browser. That needs the Pterodactyl Client API, which takes a
 * per-user or per-server key (different from the Application API key this
 * app already uses for admin operations). Add that once that credential
 * exists; the registerRoute/addServerCardAction pattern here is the same
 * either way.
 */
module.exports = {
  register(api) {
    api.addServerCardAction({
      label: 'View',
      hrefTemplate: '/manage/:id',
      icon: 'globe',
    });

    api.registerRoute('get', '/manage/:id', api.ensureAuth, (req, res) => {
      const server = api.db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) {
        return res.status(404).render('error', { message: 'Server not found.', pageTitle: 'Not Found' });
      }
      const isOwner = server.user_id === req.user.id;
      if (!isOwner && !req.user.is_admin) {
        return res.status(403).render('error', { message: "You don't have access to this server.", pageTitle: 'Error' });
      }

      const auditEntries = api.db.prepare(
        `SELECT * FROM audit_log WHERE target_type = 'server' AND target_id = ? ORDER BY created_at DESC LIMIT 25`
      ).all(String(server.id));

      const panelUrl = (process.env.PTERODACTYL_PANEL_URL && server.pterodactyl_identifier)
        ? `${process.env.PTERODACTYL_PANEL_URL}/server/${server.pterodactyl_identifier}`
        : null;

      res.render('manage/server', {
        user: req.user, pageTitle: server.name || 'Server',
        activePage: isOwner ? 'servers' : 'admin',
        server, auditEntries, panelUrl,
      });
    });
  },
};
