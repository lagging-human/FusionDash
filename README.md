# Pterodactyl Billing Dashboard (Stage 1)

Express dashboard with Discord/Google OAuth, free-server provisioning via the
Pterodactyl Application API, an admin panel, and a plans table ready for
payment integration (Stage 2).

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - Discord/Google OAuth credentials + callback URLs
   - `PTERODACTYL_PANEL_URL` and `PTERODACTYL_API_KEY` (an **Application API**
     key from your panel's Admin → API Credentials)
   - `PTERODACTYL_DEFAULT_NEST_ID`, `PTERODACTYL_DEFAULT_EGG_ID`,
     `PTERODACTYL_DEFAULT_LOCATION_ID` — found under Admin → Nests/Eggs and
     Admin → Locations in your panel
3. `npm start` → visit http://localhost:3000

## How admin access works

On every login, the app:
1. Finds or creates a matching Pterodactyl panel user by email.
2. Checks that panel user's `root_admin` flag.
3. If `root_admin` is true, the local `users.is_admin` flag is set to 1,
   granting access to `/admin`.

Admins can also manually toggle `is_admin` for any user from the admin panel
(useful for staff who shouldn't be panel root admins).

## Free server flow

- Each user can create **one** free server from `/dashboard`.
- Specs (memory/disk/cpu/databases/backups) for the free tier are set under
  Admin → Free Tier Defaults, and apply to all newly created free servers.
- Existing free servers' specs can be edited individually by an admin from
  the "All Servers" section (e.g. to give a specific admin's own free server
  more resources).
- Users can rename or delete their own servers from the dashboard.

## Database

SQLite file `data.sqlite` is created automatically on first run. Tables:
`users`, `servers`, `plans`, `settings`, `transactions`.

## Payments (Stage 2)

Two gateways are wired up via `payments.js` (plain axios, no extra SDK deps):

### Razorpay (UPI / cards / etc.)
1. Get keys from https://dashboard.razorpay.com/app/keys → set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Flow: `/checkout/:planKey?gateway=razorpay` → pick egg/node →
   `/checkout/:planKey/pay` creates a Razorpay Order → Checkout.js modal
   opens → on success, the browser posts to `/checkout/razorpay/verify`,
   which verifies the HMAC signature and provisions the server.
3. **Webhook (recommended)**: in Razorpay Dashboard → Webhooks, add
   `https://yourdomain.com/webhooks/razorpay`, subscribe to
   `payment.captured`, and set `RAZORPAY_WEBHOOK_SECRET` to match. This acts
   as a backup fulfillment path if the browser closes before `/verify` runs.

### PayPal
1. Get credentials from https://developer.paypal.com/dashboard →
   set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE=sandbox` (or `live`).
2. Flow: `/checkout/:planKey?gateway=paypal` → pick egg/node →
   `/checkout/:planKey/pay` creates a PayPal Order (Orders v2 API) and
   redirects the user to PayPal's approval page → after approval PayPal
   redirects to `/checkout/paypal/return?token=ORDER_ID`, which captures the
   order and provisions the server.

### Provisioning on payment success
Both gateways call the same `fulfillPaidTransaction()` helper, which reads
the chosen nest/egg/node + plan specs from the `transactions.deploy_config`
JSON column and calls `ptero.createServer(...)`, then inserts a row into
`servers` with `plan = <plan key>`.

### Admin visibility
The admin panel now shows a "Recent Transactions" table (user, plan,
gateway, amount, status, order id).

### Notes / caveats
- Amounts: `plans.price_inr` is stored in **paise** (e.g. ₹99.00 = 9900);
  `plans.price_usd` is a decimal USD amount for PayPal.
- This implementation creates a **new server** per purchase (it does not
  resize an existing free server into a paid one). If you'd rather upgrade
  the user's existing free server in place, swap the `ptero.createServer`
  call in `fulfillPaidTransaction` for `ptero.updateServerBuild` and update
  that server's `plan`/specs row instead of inserting a new one.
- For production, run behind HTTPS — both Razorpay and PayPal require it for
  live mode.

