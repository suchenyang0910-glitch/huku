# Haku Mini App

The project now includes a small Node.js API server, SQLite account storage, Telegram Mini App authentication, and an authenticated admin dashboard. The interface supports English (`en`), Vietnamese (`vi`), Simplified Chinese (`zh`), Khmer (`km`), and Thai (`th`), in that display order.

## Run locally

1. Use Node.js 25.7 or newer. This prototype uses Node's built-in `node:sqlite` API and does not install npm packages.
2. Copy `.env.example` to `.env`.
3. Replace the example Bot tokens and session secret. Configure every Bot that may open the Mini App in `HAKU_BOTS_JSON`. Keep `.env` private. `HAKU_ADMIN_PASSWORD` is only for one-time migration from the old shared-password login.
4. Set `HAKU_PUBLIC_ORIGIN` and `HAKU_ALLOWED_ORIGINS` to the exact URL used to open the app.
5. Run `npm start`, then open the printed local address.

The Bot configuration is server-only. Each Telegram `initData` signature is checked against enabled Bot configurations; the matching configuration is recorded as the launch source. Disabled Bots are not accepted for new Mini App authentication.

## What gets saved

Telegram IDs are saved only after the user agrees and the server accepts `POST /api/telegram/consent`. The account record contains Telegram ID, locale, source Bot ID, first/last-seen timestamps, consent time, and consent version. `last_seen` is refreshed when a saved user is verified again. Records are deleted when `last_seen` is older than `HAKU_RETENTION_DAYS` (default: 365 days); cleanup runs at startup and every 24 hours. Users can download a JSON copy or delete their saved account from the Telegram account card. Birth details, relationship answers, manga feedback, Telegram names, and usernames are not saved.

The admin route uses named `owner` and `viewer` accounts. Only owners can perform write operations; viewers can read the overview. Create accounts with `node server.mjs create-admin <username> <owner|viewer>`.

## Production deployment on truesignal.cc

### First deployment

The production host runs Caddy 2.6.2 as a systemd service. Haku listens only on `127.0.0.1:4183`; do not change the unrelated service on `4173`. `deploy/Caddyfile.example` contains the reviewed site blocks for `truesignal.cc`, `mini.truesignal.cc`, `admin.truesignal.cc`, and `api.truesignal.cc`. Caddy manages HTTPS certificates automatically.

1. Inspect and back up the live state before changing it:

   ~~~sh
   sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :4173 or sport = :4183 )'
   sudo systemctl status caddy --no-pager
   sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup-$(date -u +%Y%m%d%H%M%S)"
   ~~~

   Confirm that all five DNS records (`truesignal.cc`, `www`, `mini`, `admin`, and `api`) are proxied through Cloudflare. Keep Cloudflare SSL/TLS mode at **Full (strict)** and leave automatic HTTPS enabled in Caddy.

2. Prepare `/var/lib/haku` and the production `.env`. Keep secrets out of Git:

   ~~~dotenv
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=4183
   HAKU_PUBLIC_ORIGIN=https://mini.truesignal.cc
   HAKU_ALLOWED_ORIGINS=https://mini.truesignal.cc
   HAKU_ADMIN_ORIGIN=https://admin.truesignal.cc
   HAKU_TRUSTED_PROXY=true
   HAKU_DB_PATH=/var/lib/haku/haku.sqlite
   HAKU_RETENTION_DAYS=365
   HAKU_STATS_TIMEZONE=Asia/Phnom_Penh
   HAKU_SESSION_SECRET=<GENERATE_A_LONG_RANDOM_SECRET>
   # Optional only while migrating an empty admins table:
   # HAKU_ADMIN_PASSWORD=<OLD_SHARED_PASSWORD>
   HAKU_BOTS_JSON=[{"id":"<BOT_ID>","name":"<BOT_NAME>","token":"<BOT_TOKEN>","active":true}]
   ~~~

   Create the data directory with `sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/haku`. Compose uses host networking, binds Node to `127.0.0.1:4183`, and does not expose that port publicly. Confirm `ss -ltn 'sport = :4183'` is free before the first start.

3. Build and start only Haku, then confirm local health:

   ~~~sh
   docker compose -f deploy/compose.yml up -d --build
   docker compose -f deploy/compose.yml ps
   curl --fail --silent http://127.0.0.1:4183/api/health
   ~~~

4. Refresh the Cloudflare ranges in `deploy/Caddyfile.example` from Cloudflare's official IPv4 and IPv6 lists. Merge its four site blocks into the existing `/etc/caddy/Caddyfile`; do not replace unrelated blocks. The `mini`, `admin`, and `api` blocks accept only Cloudflare source addresses and overwrite `X-Forwarded-For` with `CF-Connecting-IP`. The API hostname exposes only `/api/*`; Node additionally restricts the admin API to `HAKU_ADMIN_ORIGIN`.

5. Validate before reloading the existing Caddy service:

   ~~~sh
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   sudo systemctl status caddy --no-pager
   ~~~

6. Before changing firewall rules, verify the SSH management path. Keep `4183` closed externally; allow public `80` and `443` only as required for Cloudflare proxying and Caddy certificate renewal. Do not change SSH rules or firewall defaults without confirming continued access.

7. In BotFather, set the Bot's Mini App and menu URLs to `https://mini.truesignal.cc`.

### Create and migrate admin accounts

For a new installation, after Haku is running create the first owner. The command prompts for a password through hidden standard input; do not put the password in command arguments:

~~~sh
docker compose -f deploy/compose.yml exec haku node server.mjs create-admin owner owner
~~~

To migrate an existing installation that used `HAKU_ADMIN_PASSWORD`, keep the old value in `.env` only while the `admins` table is empty. Sign in once with username `owner` and that old password. A successful first login creates the named owner account with a salted scrypt hash. Then remove `HAKU_ADMIN_PASSWORD` from `.env` and restart the service. The legacy password is accepted only while the table is empty and is ignored after a named account exists. Create more accounts through the same command, choosing `owner` or `viewer` as the role.

### Register Bot webhooks and profile copy

After every deployment, and whenever you add an active Bot to `HAKU_BOTS_JSON`, run the registration script on the server:

```sh
docker compose -f deploy/compose.yml exec haku node scripts/set-webhook.mjs --dry-run
docker compose -f deploy/compose.yml exec haku node scripts/set-webhook.mjs
```

Running it inside the container uses the same `.env` and `HAKU_PUBLIC_ORIGIN` as the running server and does not require Node on the host.

The script requires `HAKU_PUBLIC_ORIGIN` to use HTTPS. It registers the webhook, Mini App menu button, and localized Bot profile copy. Keep Bot tokens in the server's `.env` or secret store; the script does not print tokens or webhook secrets. The Caddy example forwards all Mini App paths and only `/api/*` on the API hostname, including `/api/telegram/webhook/`.

### Cookie compatibility

HAKU_COOKIE_SAMESITE=lax is stricter but does not work in Telegram Web's embedded iframe. Setting HAKU_COOKIE_SAMESITE=none supports more embedded-browser environments and requires Secure cookies in production. Safari may still block third-party cookies, so test the actual Telegram and Safari versions used by your audience.

### Health, 525, and origin checks

From outside the server, verify `https://mini.truesignal.cc/api/health` and `https://api.truesignal.cc/api/health` return `{"ok":true}`, `https://admin.truesignal.cc` opens the admin login, and `https://api.truesignal.cc/` returns `404`. Confirm `https://truesignal.cc` serves the static site and `www` redirects to it. A successful HTTPS response without Cloudflare 525 confirms the Caddy origin handshake. Verify direct external access to `159.223.92.104:4183` fails; locally, `curl http://127.0.0.1:4183/api/health` must succeed. If 525 remains, inspect Caddy's certificate and journal output and confirm Cloudflare remains in Full (strict) mode.

### SQLite backup and restore

Stop only the Haku container to make an offline copy. Keep the backup in a protected location outside /var/lib/haku:

~~~sh
docker compose -f deploy/compose.yml stop haku
cp --archive /var/lib/haku/haku.sqlite <BACKUP_DIR>/haku.sqlite
docker compose -f deploy/compose.yml start haku
~~~

To restore, stop Haku, copy the chosen backup over /var/lib/haku/haku.sqlite, restore ownership to UID/GID 1000, then start Haku and check /api/health.

### Upgrade and rollback

Back up `/var/lib/haku/haku.sqlite` before an upgrade. This release expands the `users.locale` constraint at startup, so do not deploy it without that backup. Check out or copy the intended release, rebuild and recreate only Haku with the same /var/lib/haku bind mount:

~~~sh
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d --force-recreate
docker compose -f deploy/compose.yml ps
~~~

After the upgraded service is healthy, run `node scripts/set-webhook.mjs` once in the Haku container to publish the Vietnamese Bot profile copy.

After health and both domains are verified, retain the previous image or commit until the rollback window closes. To roll back, check out the previous known-good commit (placeholder: <PREVIOUS_COMMIT>), rebuild, recreate Haku with the same data directory, and verify health. Do not run two containers against the same SQLite file.

### Solar-term table

`haku.html` embeds the 12 month-defining solar terms for 1930 through 2100. Birth years outside that fixed range fail explicitly instead of silently reusing the last known month. Regenerate the table with Astronomy Engine 2.1.19 (MIT license) as a build-only dependency; it is not used by the browser or server at runtime:

~~~sh
npm install --no-save --ignore-scripts astronomy-engine@2.1.19
node scripts/generate-solar-terms.mjs
~~~

The checked-in validation compares the generated UTC minutes with published tables from the National Astronomical Observatory of Japan and Taipei Astronomical Museum, allowing at most one minute of difference.

## Storage and deployment notes

- The database is `data/haku.sqlite` unless `HAKU_DB_PATH` is changed. Back it up with the service stopped or use SQLite's online backup facilities.
- Sessions are held in memory and expire after 12 hours for Mini App users and 8 hours for admins. Restarting the server signs everyone out.
- This is a single-process SQLite deployment. Use one server instance and persistent disk. A multi-instance deployment needs a shared database and session store.
- Put the server behind HTTPS before production and set `NODE_ENV=production` so session cookies are marked `Secure`.
- If the server sits behind a reverse proxy, set `HAKU_TRUSTED_PROXY=true` only when direct access to the Node port is blocked and the proxy overwrites/appends `X-Forwarded-For` correctly. Otherwise the login rate limiter will key off the proxy address.
- `node:sqlite` is still marked release-candidate in the Node 25 documentation. Pin and qualify the runtime before production upgrades.
- `HAKU_RETENTION_DAYS` defaults to 365. It controls automatic cleanup based on `last_seen`; users can also export or delete their account from the account card.
- `HAKU_STATS_TIMEZONE` defaults to `Asia/Phnom_Penh`. Overview counts and `dailyDates` use seven natural days in this timezone; stored `first_seen` values remain UTC ISO timestamps. Set another valid IANA timezone when the admin dashboard should report a different local calendar.
