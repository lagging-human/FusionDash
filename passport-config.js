const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const db = require('./db');
const { findOrCreatePanelUser, getPanelUser } = require('./pterodactyl');
const { normalizeEmail, verifyPassword } = require('./auth-utils');

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByLocalEmailStmt = db.prepare("SELECT * FROM users WHERE provider='local' AND email = ?");
const upsertUserStmt = db.prepare(`
  INSERT INTO users (id, provider, username, email, avatar, email_verified)
  VALUES (@id, @provider, @username, @email, @avatar, 1)
  ON CONFLICT(id) DO UPDATE SET
    username = @username,
    email    = @email,
    avatar   = @avatar,
    email_verified = 1
`);
const setPanelLinkStmt = db.prepare(
  'UPDATE users SET pterodactyl_user_id = ?, is_admin = ? WHERE id = ?'
);
const clearPanelLinkStmt = db.prepare(
  'UPDATE users SET pterodactyl_user_id = NULL WHERE id = ?'
);

async function syncPanelUser(localId, email, username) {
  if (!process.env.PTERODACTYL_PANEL_URL || !process.env.PTERODACTYL_API_KEY || !email) return;

  const user = getUserStmt.get(localId);

  // If we have a stored panel user id, verify it still exists on the panel.
  // If the admin deleted it manually, this 404s — we catch that and fall through
  // to re-create below.
  if (user?.pterodactyl_user_id) {
    try {
      const full = await getPanelUser(user.pterodactyl_user_id);
      const isAdmin = full.attributes.root_admin ? 1 : 0;
      setPanelLinkStmt.run(user.pterodactyl_user_id, isAdmin, localId);
      return; // still exists — all good
    } catch (err) {
      if (err.response?.status === 404) {
        // Panel user was deleted — clear the stale link and re-create below
        console.log(`Panel user ${user.pterodactyl_user_id} not found, re-creating for ${email}`);
        clearPanelLinkStmt.run(localId);
      } else {
        console.error('Panel user check failed:', err.response?.data || err.message);
        return;
      }
    }
  }

  // No panel user linked (or was just cleared) — find or create one
  try {
    const panelUser = await findOrCreatePanelUser({ email, username });
    const panelUserId = panelUser.attributes.id;
    const full = await getPanelUser(panelUserId);
    const isAdmin = full.attributes.root_admin ? 1 : 0;
    setPanelLinkStmt.run(panelUserId, isAdmin, localId);
  } catch (err) {
    console.error('Pterodactyl link failed:', err.response?.data || err.message);
  }
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = getUserStmt.get(id);
  done(null, user || null);
});

passport.use(new DiscordStrategy(
  {
    clientID:     process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL:  process.env.DISCORD_CALLBACK_URL,
    scope: ['identify', 'email']
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const id = `discord:${profile.id}`;
      upsertUserStmt.run({
        id,
        provider: 'discord',
        username: `${profile.username}${profile.discriminator !== '0' ? '#' + profile.discriminator : ''}`,
        email:    profile.email,
        avatar:   profile.avatar
          ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
          : null
      });
      await syncPanelUser(id, profile.email, profile.username);
      done(null, getUserStmt.get(id));
    } catch (err) { done(err); }
  }
));

passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
    scope: ['profile', 'email']
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const id = `google:${profile.id}`;
      upsertUserStmt.run({
        id,
        provider: 'google',
        username: profile.displayName,
        email:    profile.emails?.[0]?.value,
        avatar:   profile.photos?.[0]?.value || null
      });
      await syncPanelUser(id, profile.emails?.[0]?.value, profile.displayName);
      done(null, getUserStmt.get(id));
    } catch (err) { done(err); }
  }
));

// Email + password login. The DB row already exists by the time this runs
// (created by the /register or /admin/users/new handlers) — this strategy
// only ever authenticates, never creates accounts.
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const user = getUserByLocalEmailStmt.get(normalizeEmail(email));
      if (!user || !user.password_hash) {
        return done(null, false, { message: 'Incorrect email or password.' });
      }
      const match = await verifyPassword(password, user.password_hash);
      if (!match) return done(null, false, { message: 'Incorrect email or password.' });
      done(null, user);
    } catch (err) { done(err); }
  }
));

module.exports = passport;
// Exposed so server.js can link a freshly created local/admin-created account
// to the Pterodactyl panel the same way OAuth signups already do.
module.exports.syncPanelUser = syncPanelUser;
