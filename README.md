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