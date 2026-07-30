'use strict';
const pc = require('./client-api');
const lang = require('../../lang');
const { encrypt } = require('../../crypto-util');

const TABS = [
  { id: 'console',   label: 'Console',   path: 'console' },
  { id: 'files',      label: 'Files',      path: 'files' },
  { id: 'databases', label: 'Databases', path: 'databases' },
  { id: 'users',      label: 'Subusers',   path: 'users' },
  { id: 'startup',    label: 'Startup',    path: 'startup' },
  { id: 'settings',  label: 'Settings',   path: 'settings' },
  { id: 'auditlog',   label: 'Audit Log',  path: 'auditlog' },
];

module.exports = {
  register(api) {
    api.addServerCardAction({
      label: lang.t('pteroview.view_button', 'View'),
      hrefTemplate: '/server/:id/console',
      icon: 'globe',
    });

    // ── Account-wide Pterodactyl API key connection ──────────────────────
    api.registerRoute('get', '/account/pterodactyl-key', api.ensureAuth, (req, res) => {
      res.render('pteroview/connect-key', {
        user: req.user, pageTitle: 'Connect Pterodactyl',
        connected: pc.hasKey(req.user),
        error: req.query.error, success: req.query.success,
        returnTo: req.query.returnTo || '/servers',
      });
    });

    api.registerRoute('post', '/account/pterodactyl-key', api.ensureAuth, async (req, res) => {
      const rawKey = (req.body.apiKey || '').trim();
      const returnTo = req.body.returnTo || '/servers';
      if (!rawKey) {
        return res.redirect('/account/pterodactyl-key?error=' + encodeURIComponent('Paste a key first.'));
      }
      const valid = await pc.validateKey(rawKey);
      if (!valid) {
        return res.redirect('/account/pterodactyl-key?error=' + encodeURIComponent(
          "That key didn't work — check it's a Client API key (Account Settings -> API Credentials in Pterodactyl), not the Application API key."));
      }
      api.db.prepare('UPDATE users SET pterodactyl_client_key_enc = ? WHERE id = ?').run(encrypt(rawKey), req.user.id);
      api.audit(req.user, 'pterodactyl_key.connect', { type:'user', id:req.user.id, name:req.user.username || req.user.email }, {}, req.ip);
      res.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent('Pterodactyl account connected.'));
    });

    api.registerRoute('post', '/account/pterodactyl-key/remove', api.ensureAuth, (req, res) => {
      api.db.prepare('UPDATE users SET pterodactyl_client_key_enc = NULL WHERE id = ?').run(req.user.id);
      api.audit(req.user, 'pterodactyl_key.remove', { type:'user', id:req.user.id, name:req.user.username || req.user.email }, {}, req.ip);
      res.redirect('/account/pterodactyl-key?success=' + encodeURIComponent('Disconnected.'));
    });

    // ── Shared guard: ownership + key-connected check, wraps every /server/:id/* route ──
    const withServer = (handler) => [api.ensureAuth, async (req, res) => {
      const server = api.db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) return res.status(404).render('error', { message: 'Server not found.', pageTitle: 'Not Found' });
      const isOwner = server.user_id === req.user.id;
      if (!isOwner && !req.user.is_admin) {
        return res.status(403).render('error', { message: "You don't have access to this server.", pageTitle: 'Error' });
      }
      if (!server.pterodactyl_identifier) {
        return res.status(400).render('error', { message: 'This server has no linked Pterodactyl instance yet.', pageTitle: 'Error' });
      }
      if (!pc.hasKey(req.user)) {
        return res.render('pteroview/connect-key', {
          user: req.user, pageTitle: 'Connect Pterodactyl', connected: false,
          error: null, success: null, returnTo: req.originalUrl, server,
        });
      }
      try {
        await handler(req, res, server);
      } catch (e) {
        const apiMsg = e.response?.data?.errors?.[0]?.detail;
        res.render('pteroview/panel-error', {
          user: req.user, server, pageTitle: 'Error', tabs: TABS, activeTab: null,
          message: apiMsg || e.message || 'Something went wrong talking to Pterodactyl.',
        });
      }
    }];

    const ident = (server) => server.pterodactyl_identifier;

    api.registerRoute('get', '/server/:id/console', ...withServer(async (req, res, server) => {
      const [resources, ws] = await Promise.all([
        pc.resources(req.user, ident(server)).catch(() => null),
        pc.websocketToken(req.user, ident(server)),
      ]);
      res.render('pteroview/console', { user: req.user, server, tabs: TABS, activeTab: 'console', pageTitle: `${server.name} — Console`, resources, ws });
    }));

    api.registerRoute('get', '/server/:id/files', ...withServer(async (req, res, server) => {
      const dir = req.query.dir || '/';
      const files = await pc.listFiles(req.user, ident(server), dir);
      res.render('pteroview/files', { user: req.user, server, tabs: TABS, activeTab: 'files', pageTitle: `${server.name} — Files`, files, dir, success: req.query.success, error: null });
    }));

    api.registerRoute('post', '/server/:id/files/delete', ...withServer(async (req, res, server) => {
      const dir = req.body.dir || '/';
      const name = req.body.name;
      await pc.deleteFiles(req.user, ident(server), dir, [name]);
      api.audit(req.user, 'pterodactyl.file_delete', { type:'server', id:server.id, name:server.name }, { file: name, dir }, req.ip);
      res.redirect(`/server/${server.id}/files?dir=${encodeURIComponent(dir)}&success=${encodeURIComponent('Deleted ' + name)}`);
    }));

    const MAX_EDITABLE_SIZE = 2 * 1024 * 1024; // 2MB — plenty for config files, not for logs/jars

    api.registerRoute('get', '/server/:id/files/edit', ...withServer(async (req, res, server) => {
      const filePath = req.query.path;
      if (!filePath) return res.redirect(`/server/${server.id}/files`);
      const dir = filePath.split('/').slice(0, -1).join('/') || '/';
      const fileName = filePath.split('/').pop();

      // Confirm size before pulling content — the list endpoint already has it, no need to fetch-then-reject.
      const siblingFiles = await pc.listFiles(req.user, ident(server), dir);
      const meta = siblingFiles.find(f => f.name === fileName);
      if (meta && meta.size > MAX_EDITABLE_SIZE) {
        return res.render('pteroview/files', {
          user: req.user, server, tabs: TABS, activeTab: 'files', pageTitle: `${server.name} — Files`,
          files: siblingFiles, dir, success: null,
          error: `${fileName} is ${(meta.size / 1024 / 1024).toFixed(1)}MB — too large to edit here (2MB limit). Use the Pterodactyl panel directly for large files.`,
        });
      }

      const content = await pc.readFile(req.user, ident(server), filePath);
      const looksBinary = /\x00|[\x01-\x08\x0E-\x1F]/.test(content.slice(0, 8000));
      res.render('pteroview/file-edit', {
        user: req.user, server, tabs: TABS, activeTab: 'files', pageTitle: `${server.name} — ${fileName}`,
        filePath, fileName, dir, content: looksBinary ? null : content, looksBinary,
      });
    }));

    api.registerRoute('post', '/server/:id/files/edit', ...withServer(async (req, res, server) => {
      const filePath = req.body.path;
      await pc.writeFile(req.user, ident(server), filePath, req.body.content ?? '');
      api.audit(req.user, 'pterodactyl.file_write', { type:'server', id:server.id, name:server.name }, { file: filePath }, req.ip);
      const dir = filePath.split('/').slice(0, -1).join('/') || '/';
      res.redirect(`/server/${server.id}/files?dir=${encodeURIComponent(dir)}&success=${encodeURIComponent('Saved ' + filePath.split('/').pop())}`);
    }));

    api.registerRoute('get', '/server/:id/databases', ...withServer(async (req, res, server) => {
      const databases = await pc.listDatabases(req.user, ident(server));
      res.render('pteroview/databases', { user: req.user, server, tabs: TABS, activeTab: 'databases', pageTitle: `${server.name} — Databases`, databases, success: req.query.success });
    }));

    api.registerRoute('post', '/server/:id/databases/:dbId/delete', ...withServer(async (req, res, server) => {
      await pc.deleteDatabase(req.user, ident(server), req.params.dbId);
      api.audit(req.user, 'pterodactyl.database_delete', { type:'server', id:server.id, name:server.name }, { database: req.params.dbId }, req.ip);
      res.redirect(`/server/${server.id}/databases?success=${encodeURIComponent('Database deleted.')}`);
    }));

    api.registerRoute('get', '/server/:id/users', ...withServer(async (req, res, server) => {
      const subusers = await pc.listSubusers(req.user, ident(server));
      res.render('pteroview/users', { user: req.user, server, tabs: TABS, activeTab: 'users', pageTitle: `${server.name} — Subusers`, subusers, error: req.query.error, success: req.query.success });
    }));

    api.registerRoute('post', '/server/:id/users/invite', ...withServer(async (req, res, server) => {
      const email = (req.body.email || '').trim();
      const permissions = (req.body.permissions || '').split(',').map(s => s.trim()).filter(Boolean);
      await pc.inviteSubuser(req.user, ident(server), email, permissions.length ? permissions : ['control.console', 'control.start', 'control.stop']);
      api.audit(req.user, 'pterodactyl.subuser_invite', { type:'server', id:server.id, name:server.name }, { email }, req.ip);
      res.redirect(`/server/${server.id}/users?success=${encodeURIComponent('Invited ' + email)}`);
    }));

    api.registerRoute('post', '/server/:id/users/:subuserId/remove', ...withServer(async (req, res, server) => {
      await pc.removeSubuser(req.user, ident(server), req.params.subuserId);
      api.audit(req.user, 'pterodactyl.subuser_remove', { type:'server', id:server.id, name:server.name }, { subuser: req.params.subuserId }, req.ip);
      res.redirect(`/server/${server.id}/users?success=${encodeURIComponent('Removed.')}`);
    }));

    api.registerRoute('get', '/server/:id/settings', ...withServer(async (req, res, server) => {
      const details = await pc.serverDetails(req.user, ident(server));
      res.render('pteroview/settings', { user: req.user, server, tabs: TABS, activeTab: 'settings', pageTitle: `${server.name} — Settings`, details, success: req.query.success });
    }));

    api.registerRoute('post', '/server/:id/settings/rename', ...withServer(async (req, res, server) => {
      await pc.renameServer(req.user, ident(server), req.body.name, req.body.description || '');
      api.db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(req.body.name, server.id);
      api.audit(req.user, 'pterodactyl.rename', { type:'server', id:server.id, name:req.body.name }, {}, req.ip);
      res.redirect(`/server/${server.id}/settings?success=${encodeURIComponent('Saved.')}`);
    }));

    api.registerRoute('get', '/server/:id/startup', ...withServer(async (req, res, server) => {
      const { variables, meta } = await pc.listStartup(req.user, ident(server));
      res.render('pteroview/startup', { user: req.user, server, tabs: TABS, activeTab: 'startup', pageTitle: `${server.name} — Startup`, variables, meta, success: req.query.success });
    }));

    api.registerRoute('post', '/server/:id/startup/update', ...withServer(async (req, res, server) => {
      await pc.updateStartupVariable(req.user, ident(server), req.body.key, req.body.value || '');
      api.audit(req.user, 'pterodactyl.startup_update', { type:'server', id:server.id, name:server.name }, { key: req.body.key }, req.ip);
      res.redirect(`/server/${server.id}/startup?success=${encodeURIComponent('Updated ' + req.body.key)}`);
    }));

    api.registerRoute('get', '/server/:id/auditlog', ...withServer(async (req, res, server) => {
      const entries = api.db.prepare(
        `SELECT * FROM audit_log WHERE target_type = 'server' AND target_id = ? ORDER BY created_at DESC LIMIT 50`
      ).all(String(server.id));
      res.render('pteroview/auditlog', { user: req.user, server, tabs: TABS, activeTab: 'auditlog', pageTitle: `${server.name} — Audit Log`, entries });
    }));
  },
};
