const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./db');
const { findOrCreatePanelUser, getPanelUser } = require('./pterodactyl');

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const upsertUserStmt = db.prepare(`
  INSERT INTO users (id, provider, username, email, avatar)
  VALUES (@id, @provider, @username, @email, @avatar)
  ON CONFLICT(id) DO UPDATE SET
    username = @username,
    email    = @email,
    avatar   = @avatar
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

  if (user?.pterodactyl_user_id) {
    try {
      const full = await getPanelUser(user.pterodactyl_user_id);
      const isAdmin = full.attributes.root_admin ? 1 : 0;
      setPanelLinkStmt.run(user.pterodactyl_user_id, isAdmin, localId);
      return;
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`Panel user ${user.pterodactyl_user_id} not found, re-creating for ${email}`);
        clearPanelLinkStmt.run(localId);
      } else {
        console.error('Panel user check failed:', err.response?.data || err.message);
        return;
      }
    }
  }

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

module.exports = passport;
