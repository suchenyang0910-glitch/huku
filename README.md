# Haku Mini App

The project now includes a small Node.js API server, SQLite account storage, Telegram Mini App authentication, and an authenticated admin dashboard.

## Run locally

1. Use Node.js 25.7 or newer. This prototype uses Node's built-in `node:sqlite` API and does not install npm packages.
2. Copy `.env.example` to `.env`.
3. Replace the example Bot tokens, admin password, and session secret. Configure every Bot that may open the Mini App in `HAKU_BOTS_JSON`. Keep `.env` private.
4. Set `HAKU_PUBLIC_ORIGIN` and `HAKU_ALLOWED_ORIGINS` to the exact URL used to open the app.
5. Run `npm start`, then open the printed local address.

The Bot configuration is server-only. Each Telegram `initData` signature is checked against enabled Bot configurations; the matching configuration is recorded as the launch source. Disabled Bots are not accepted for new Mini App authentication.

## What gets saved

Telegram IDs are persisted only after the user checks the account-consent box and the server accepts `POST /api/telegram/consent`. The SQLite record stores Telegram ID, locale, source Bot ID, first/last-seen time, and consent time/version. Birth details, relationship answers, manga feedback, Telegram names, and usernames are not stored by this server.

The admin route requires the password configured in `HAKU_ADMIN_PASSWORD`. It shows live values only after a valid admin session; when opening the HTML file without the API, the UI shows clearly labeled sample data.

## Storage and deployment notes

- The database is `data/haku.sqlite` unless `HAKU_DB_PATH` is changed. Back it up with the service stopped or use SQLite's online backup facilities.
- Sessions are held in memory and expire after 12 hours for Mini App users and 8 hours for admins. Restarting the server signs everyone out.
- This is a single-process SQLite deployment. Use one server instance and persistent disk. A multi-instance deployment needs a shared database and session store.
- Put the server behind HTTPS before production and set `NODE_ENV=production` so session cookies are marked `Secure`.
- If the server sits behind a reverse proxy, set `HAKU_TRUSTED_PROXY=true` only when direct access to the Node port is blocked and the proxy overwrites/appends `X-Forwarded-For` correctly. Otherwise the login rate limiter will key off the proxy address.
- `node:sqlite` is still marked release-candidate in the Node 25 documentation. Pin and qualify the runtime before production upgrades.
- Configure an account retention/deletion policy before launch. No delete/export endpoint is included yet.
