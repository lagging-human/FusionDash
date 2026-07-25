'use strict';

const rateLimit = require('express-rate-limit');

// These only ever sit on a handful of routes: POST /login, POST /register,
// POST /forgot-password, POST /resend-verification. Every other route in
// the app is untouched — normal browsing, dashboard use, server management,
// etc. never hits a limiter.

/**
 * Login attempts — protects against credential brute-forcing.
 * Generous enough that a normal user mistyping their password a few times
 * never sees it.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
  handler: (req, res) => res.redirect('/login?error=' + encodeURIComponent('Too many attempts. Please wait a few minutes and try again.')),
});

/**
 * Anything that sends an email on our behalf (registration, forgot-password,
 * resend-verification). These share a budget because they all draw from the
 * same limited daily SMTP quota — the real defense against bots burning
 * through that quota is here, not just the per-route login limiter above.
 */
const emailSendingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a while before trying again.' },
  handler: (req, res) => {
    const back = req.originalUrl.split('?')[0] || '/login';
    res.redirect(back + '?error=' + encodeURIComponent('Too many requests from this connection. Please wait a while before trying again.'));
  },
});

module.exports = { loginLimiter, emailSendingLimiter };
