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

The admin route requires the password configured in `HAKU_ADMIN_PASSWORD`.

## Telegram Bot welcome webhook

After every deployment, and whenever you add an active Bot to `HAKU_BOTS_JSON`, run `node scripts/set-webhook.mjs` on the server. Use `node scripts/set-webhook.mjs --dry-run` to preview the operations first. Registration requires an HTTPS `HAKU_PUBLIC_ORIGIN` and configures the webhook, Mini App menu button, and localized Bot profile copy. Keep Bot tokens in the server's `.env` or secret store; the script never prints tokens or webhook secrets. If a reverse proxy allowlists paths, permit `/api/telegram/webhook/`.
 It shows live values only after a valid admin session; when opening the HTML file without the API, the UI shows clearly labeled sample data.

## Docker deployment on mini.truesignal.cc

### First deployment

1. **Inspect the existing listeners before touching ports.** The current 401 response on port 80 does not identify its owner. On the server, inspect listeners and the active service configuration first:

   ~~~sh
   sudo ss -ltnp '( sport = :80 or sport = :443 )'
   sudo ps -o user=,pid=,comm= -p <PID>
   sudo systemctl status nginx apache2 caddy
   ~~~

   Do not stop or replace the port 80 service until its process owner and purpose are confirmed. If it is Nginx, add the Haku server blocks to that Nginx instance and reload after a successful syntax check. Preserve the active truesignal.cc HTTPS virtual host, its application routes, and its existing document root. The example root in the config is only a placeholder: /var/www/<EXISTING_TRUESIGNAL_SITE_ROOT>.

2. In Cloudflare, create an Origin Certificate covering mini.truesignal.cc and the existing truesignal.cc hostnames. Install the certificate and private key at the paths referenced in deploy/nginx-haku.conf with owner-only key permissions. In the Cloudflare dashboard, set SSL/TLS encryption mode to **Full (strict)**.

3. Prepare persistent storage and a production .env file. The following values are examples; replace every angle-bracket placeholder on the server and keep the file out of Git:

   ~~~dotenv
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=4173
   HAKU_PUBLIC_ORIGIN=https://mini.truesignal.cc
   HAKU_ALLOWED_ORIGINS=https://mini.truesignal.cc
   HAKU_TRUSTED_PROXY=true
   HAKU_DB_PATH=/var/lib/haku/haku.sqlite
   HAKU_SESSION_SECRET=<GENERATE_A_LONG_RANDOM_SECRET>
   HAKU_ADMIN_PASSWORD=<SET_A_STRONG_PASSWORD>
   HAKU_BOTS_JSON=[{"id":"<BOT_ID>","name":"<BOT_NAME>","token":"<BOT_TOKEN>","active":true}]
   ~~~

   Create /var/lib/haku and give it to the image's node user (UID 1000), for example with install -d -m 0750 -o 1000 -g 1000 /var/lib/haku. The Compose file uses host networking so Node can bind only to 127.0.0.1:4173; it does not publish port 4173 to the network.

4. Install the proxy files without replacing the main website configuration. Copy deploy/cloudflare-realip.conf to /etc/nginx/snippets/haku-cloudflare-realip.conf and deploy/nginx-haku.conf into the active Nginx include directory. The real-IP snippet contains the Cloudflare origin-facing ranges from the official list; refresh it before applying and whenever Cloudflare changes its ranges. It trusts CF-Connecting-IP only from those ranges. Nginx replaces X-Forwarded-For with the single resolved $remote_addr value.

5. Before changing firewall rules, inspect the current rules and verify the required operator source for SSH. Allow SSH only from the approved operator CIDR, allow ports 80 and 443 only from the current Cloudflare IP ranges, and keep 4173 closed externally. Remove any broad existing 80/443 allow rule only after verifying the current website also uses Cloudflare and the replacement allow rules are active. Do not change firewall defaults or SSH rules without confirming the management path remains open.

6. Validate the active Nginx configuration, then reload the existing service without stopping it:

   ~~~sh
   sudo nginx -t
   sudo systemctl reload nginx
   ~~~

   Deploy Haku:

   ~~~sh
   docker compose -f deploy/compose.yml up -d --build
   docker compose -f deploy/compose.yml ps
   ~~~

7. In BotFather, set the Bot's Mini App URL (and menu button URL, if used) to https://mini.truesignal.cc.

### Cookie compatibility

HAKU_COOKIE_SAMESITE=lax is stricter but does not work in Telegram Web's embedded iframe. Setting HAKU_COOKIE_SAMESITE=none supports more embedded-browser environments and requires Secure cookies in production. Safari may still block third-party cookies, so test the actual Telegram and Safari versions used by your audience.

### Health, 525, and origin checks

From outside the server, verify that https://mini.truesignal.cc/api/health returns {"ok":true} and that https://truesignal.cc still serves the existing website. A successful HTTPS response without a Cloudflare 525 means the origin TLS handshake is working. Also verify that a direct external request to 159.223.92.104:4173 fails; on the server itself, curl http://127.0.0.1:4173/api/health should return {"ok":true}. If 525 remains, check that port 443 presents the installed Origin Certificate for the requested hostname and that the Cloudflare zone uses Full (strict).

### SQLite backup and restore

Stop only the Haku container to make an offline copy. Keep the backup in a protected location outside /var/lib/haku:

~~~sh
docker compose -f deploy/compose.yml stop haku
cp --archive /var/lib/haku/haku.sqlite <BACKUP_DIR>/haku.sqlite
docker compose -f deploy/compose.yml start haku
~~~

To restore, stop Haku, copy the chosen backup over /var/lib/haku/haku.sqlite, restore ownership to UID/GID 1000, then start Haku and check /api/health.

### Upgrade and rollback

Back up SQLite before an upgrade. Check out or copy the intended release, rebuild and recreate only Haku with the same /var/lib/haku bind mount:

~~~sh
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d --force-recreate
docker compose -f deploy/compose.yml ps
~~~

After health and both domains are verified, retain the previous image or commit until the rollback window closes. To roll back, check out the previous known-good commit (placeholder: <PREVIOUS_COMMIT>), rebuild, recreate Haku with the same data directory, and verify health. Do not run two containers against the same SQLite file.

## Storage and deployment notes

- The database is `data/haku.sqlite` unless `HAKU_DB_PATH` is changed. Back it up with the service stopped or use SQLite's online backup facilities.
- Sessions are held in memory and expire after 12 hours for Mini App users and 8 hours for admins. Restarting the server signs everyone out.
- This is a single-process SQLite deployment. Use one server instance and persistent disk. A multi-instance deployment needs a shared database and session store.
- Put the server behind HTTPS before production and set `NODE_ENV=production` so session cookies are marked `Secure`.
- If the server sits behind a reverse proxy, set `HAKU_TRUSTED_PROXY=true` only when direct access to the Node port is blocked and the proxy overwrites/appends `X-Forwarded-For` correctly. Otherwise the login rate limiter will key off the proxy address.
- `node:sqlite` is still marked release-candidate in the Node 25 documentation. Pin and qualify the runtime before production upgrades.
- Configure an account retention/deletion policy before launch. No delete/export endpoint is included yet.
