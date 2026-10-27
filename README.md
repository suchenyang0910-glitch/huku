# Haku Mini App

The project now includes a small Node.js API server, SQLite account storage, Telegram Mini App authentication, and an authenticated admin dashboard.

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

## Docker deployment on mini.truesignal.cc

### Before changing the current server

Do not replace the existing site or Caddy configuration until its owner, content, and active routing have been confirmed. An earlier request without a `Host` header received `401`; that response alone did not identify the site or its owner. The server has since been confirmed to run Caddy, and the proxied hostnames have returned Cloudflare `525` errors because the origin does not currently present usable certificates.

On the server, inspect how Caddy runs and read its current configuration:

~~~sh
sudo systemctl status caddy --no-pager
docker ps
sudo sed -n '1,240p' /etc/caddy/Caddyfile
sudo ss -ltnp '( sport = :80 or sport = :443 )'
~~~

Confirm whether Caddy is managed by systemd or Docker. Identify who owns the existing `truesignal.cc` content and whether it is still in use. Back up `/etc/caddy/Caddyfile` and the current website files before changing either. Preserve unrelated Caddy sites and routes.

After verifying that `/var/www/truesignal/current` is the active site root, make a dated backup:

~~~sh
backup_id="$(date -u +%Y%m%d%H%M%S)"
sudo install -d -m 0700 /var/backups/truesignal-caddy
sudo cp -a /etc/caddy/Caddyfile "/var/backups/truesignal-caddy/Caddyfile.$backup_id"
sudo cp -a "$(readlink -f /var/www/truesignal/current)" "/var/backups/truesignal-caddy/site.$backup_id"
~~~

If Caddy runs in Docker, its `127.0.0.1` is the container's loopback, not the host's. Because Haku binds only to host `127.0.0.1:4173`, the simplest supported setup is to run Caddy with host networking on Linux. If host networking cannot be used, bind Haku to a host address reachable from the Caddy container, proxy to that address, and add firewall rules that permit port 4173 only from the Caddy container. Do not expose 4173 publicly.

### Origin certificate and Cloudflare

In Cloudflare, open **SSL/TLS �� Origin Server** and create an Origin Certificate covering `truesignal.cc` and `*.truesignal.cc`. Install the certificate and private key as `/etc/caddy/certs/truesignal-origin.pem` and `/etc/caddy/certs/truesignal-origin.key`. The private key must have mode `600` and be owned by the Caddy process user; for a container, ensure the file is readable by that container's Caddy user. Set Cloudflare's SSL/TLS mode to **Full (strict)**. The explicit `tls` directives in [deploy/Caddyfile.example](deploy/Caddyfile.example) use this certificate so Caddy does not try to obtain an ACME certificate for these sites.

Authenticated Origin Pulls (AOP) is optional. Enable it for the matching hostnames in Cloudflare, install the corresponding Origin Pull CA at `/etc/caddy/certs/origin-pull-ca.pem`, and add this block inside each site's `tls` block:

~~~caddyfile
client_auth {
    mode require_and_verify
    trust_pool file /etc/caddy/certs/origin-pull-ca.pem
}
~~~

Use the CA corresponding to the AOP mode you enabled. Do not require client certificates on the origin before AOP is enabled in Cloudflare.

### Prepare and validate the release

The example requires Caddy **2.8.4 or newer**. Check the binary used by systemd with `caddy version`; for Docker, use `docker exec <CADDY_CONTAINER> caddy version`. Prepare the persistent database and a private production `.env` file using `.env.example` as the template. Replace all sample Bot values and generate a unique session secret; do not commit or share `.env`:

~~~dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
HAKU_PUBLIC_ORIGIN=https://mini.truesignal.cc
HAKU_ALLOWED_ORIGINS=https://mini.truesignal.cc
HAKU_TRUSTED_PROXY=true
HAKU_DB_PATH=/var/lib/haku/haku.sqlite
HAKU_RETENTION_DAYS=365
HAKU_STATS_TIMEZONE=Asia/Phnom_Penh
HAKU_SESSION_SECRET=<GENERATE_A_LONG_RANDOM_SECRET>
HAKU_BOTS_JSON=[{"id":"<BOT_ID>","name":"<BOT_NAME>","token":"<BOT_TOKEN>","active":true}]
~~~

Create the persistent directory for the image's Node user (UID 1000):

~~~sh
install -d -m 0750 -o 1000 -g 1000 /var/lib/haku
~~~

Merge the three site blocks from `deploy/Caddyfile.example` into the existing Caddyfile; do not replace the entire file. The global `trusted_proxies` list must stay current with Cloudflare's official IPv4 and IPv6 lists. Only requests from those proxy ranges can use `CF-Connecting-IP` as the client address. Caddy sets the single `X-Forwarded-For` value to `{client_ip}` before forwarding to Node, replacing any visitor-supplied value. Do not add response header overrides to the Mini App site block; Haku sets its own security headers.

Format and validate the merged Caddyfile before reloading:

~~~sh
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
~~~

For Docker-managed Caddy, format the host-mounted Caddyfile before validation, then validate and reload with `docker exec <CADDY_CONTAINER> caddy validate --config /etc/caddy/Caddyfile` and `docker exec <CADDY_CONTAINER> caddy reload --config /etc/caddy/Caddyfile`. Ensure the mounted Caddyfile is writable for formatting and visible at that container path.

### Start Haku, publish the website, then reload Caddy

Prepare both upstreams before activating the new Caddy routes:

1. From the checked-out Haku repository, start the app and confirm local health:

   ~~~sh
   docker compose -f deploy/compose.yml up -d --build
   docker compose -f deploy/compose.yml ps
   curl -i http://127.0.0.1:4173/api/health
   ~~~

   This repository's health route permits unauthenticated `GET` and `HEAD`. If the server still returns `{"error":"UNAUTHENTICATED"}`, do not count it as healthy: check which container or process owns port 4173 and confirm the deployed image was rebuilt from this repository.

2. Publish `site/dist/` using the release directory and `current` symlink procedure in [site/README.md](site/README.md).
3. After Haku and the static release are ready, reload Caddy. For systemd use `sudo systemctl reload caddy`; for Docker use the `caddy reload` command above. This prevents the new proxy routes from being activated before their upstreams exist.
4. In BotFather, set the Mini App URL to `https://mini.truesignal.cc`. After deployment, run `node scripts/set-webhook.mjs` from the repository on the server.

### Firewall and verification

Allow ports 80 and 443 only from the current Cloudflare IP ranges. Restrict port 22 to the approved operator source CIDR. Keep 4173 blocked from the public internet. Verify the firewall rules before removing any existing broad allow rule, and confirm the SSH management path remains open before changing rules.

After reload, check each item:

~~~sh
curl -I https://mini.truesignal.cc/api/health
curl -I https://truesignal.cc/
curl -I https://www.truesignal.cc/
curl -i https://truesignal.cc/this-path-should-not-exist
~~~

- Mini App health must return `200` without a Cloudflare `525`.
- The website home must return `200` with the CSP response header.
- `www.truesignal.cc` must return `301` to `https://truesignal.cc{uri}`.
- An unknown website route must return status `404` and the contents of `site/dist/404.html`.
- From outside the server, connecting to `159.223.92.104:4173` must fail.
- Repeated invalid admin logins from one client must be rate limited. A forged `X-Forwarded-For` must not change the client IP used by the limiter.

If the direct local health check returns `{"error":"UNAUTHENTICATED"}`, investigate the running app before treating the external HTTPS check as meaningful. The repository's health handler is public; this response indicates that the process currently bound to 4173 is not serving the expected code.

### Roll back

Restore the backed-up Caddyfile and validate it before reloading:

~~~sh
sudo cp /var/backups/truesignal-caddy/Caddyfile.<BACKUP_TIMESTAMP> /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
~~~

For Docker-managed Caddy, restore the host-mounted backup, validate inside the container, then run `docker exec <CADDY_CONTAINER> caddy reload --config /etc/caddy/Caddyfile`. Restore the previous website symlink using the rollback instructions in `site/README.md`. Keep the SQLite backup and previous static release until the rollback window has closed.

### Create and migrate admin accounts

For a new installation, after Haku is running create the first owner. The command prompts for a password through hidden standard input; do not put the password in command arguments:

~~~sh
docker compose -f deploy/compose.yml exec haku node server.mjs create-admin owner owner
~~~

To migrate an existing installation that used `HAKU_ADMIN_PASSWORD`, keep the old value in `.env` only while the `admins` table is empty. Sign in once with username `owner` and that old password. A successful first login creates the named owner account with a salted scrypt hash. Then remove `HAKU_ADMIN_PASSWORD` from `.env` and restart the service. The legacy password is accepted only while the table is empty and is ignored after a named account exists. Create more accounts through the same command, choosing `owner` or `viewer` as the role.

### Register Bot webhooks and profile copy

After every deployment, and whenever you add an active Bot to `HAKU_BOTS_JSON`, run the registration script on the server:

```sh
node scripts/set-webhook.mjs --dry-run
node scripts/set-webhook.mjs
```

The script requires `HAKU_PUBLIC_ORIGIN` to use HTTPS. It registers the webhook, Mini App menu button, and localized Bot profile copy. Keep Bot tokens in the server's `.env` or secret store; the script does not print tokens or webhook secrets. The Caddy example forwards all paths to Node. If your reverse proxy has an allowlist, permit `/api/telegram/webhook/`.

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
- `HAKU_RETENTION_DAYS` defaults to 365. It controls automatic cleanup based on `last_seen`; users can also export or delete their account from the account card.
- `HAKU_STATS_TIMEZONE` defaults to `Asia/Phnom_Penh`. Overview counts and `dailyDates` use seven natural days in this timezone; stored `first_seen` values remain UTC ISO timestamps. Set another valid IANA timezone when the admin dashboard should report a different local calendar.

