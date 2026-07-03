# FusionDash Features

## Auth
- Discord and Google OAuth2
- Pterodactyl panel account auto-created or re-created if deleted
- Admin status synced from panel `root_admin` flag

## Resource Pool
- Default allocation per user (configurable in admin panel)
- Resources consumed on server create, returned on delete
- Users buy more from the store with coins

## Server Management
- 3-step creation wizard with live resource sliders
- Software (Nest/Egg) and Node pulled live from Pterodactyl API
- Server description auto-set to dashboard URL
- Rename and delete own servers

## Server Renewal
- Admin can enable/disable renewal globally
- Configurable price (coins), period (days), grace period (days)
- Overdue servers suspended then permanently deleted after grace period
- Users renew from the dashboard with coins

## Server Queue
- Server creation is queued instead of fired directly
- One job processed at a time per node to prevent overload
- Dashboard polls queue status every 3 seconds and reloads when done

## Coin System
- Daily bonus, offerwall integrations, admin gifts
- Spent in the store on resources
- Full transaction log per user

## Earn Integrations
- Work.ink (link locker + postback)
- Paymentwall (embedded offerwall + pingback)
- Notik (offer redirect + postback)

## Store
- Buy RAM, Disk, CPU, Ports, Databases, Backups with coins
- 1×, 2×, 5×, 10× quick-buy and custom quantity
- Items fully manageable from admin panel

## Paid Plans
- Razorpay (UPI/cards) and PayPal checkout
- Server provisioned automatically on payment success
- Monthly subscription tracking with cancel support

## Admin Panel
- Tabbed layout: Settings, Earn APIs, Plans, Store, Servers, Users, Transactions
- Per-user resource pool and coin management
- Renewal system toggle and configuration
- Auto-update trigger button

## Audit Log
- Every admin action logged with timestamp, admin name, target, detail, and IP
- Filterable by action type, admin name, and date range
- Paginated, accessible at `/admin/audit`

## Branding
- App name and favicon URL configurable without code changes
- Shown in page titles, sidebar, login page, and mobile bar

## Public Landing
- Live stats page for logged-out visitors
- `/api/stats` JSON endpoint

## CLI
- `npm run create:user` — create admin or normal user without OAuth

## Auto-Update
- Checks GitHub for new commits on a configurable interval
- Pulls and restarts via PM2 automatically
