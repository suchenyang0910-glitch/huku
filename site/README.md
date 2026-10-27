# Haku public website

Static, four-language website for `truesignal.cc`. The committed `site/dist/` is the deployment artifact; the server does not need Node, npm, fonts, or image tools to serve it.

## Build and verify

From the repository root:

```sh
node site/build.mjs
node site/check.mjs
```

`site/build.mjs` reads `site/site.config.json`, the locale JSON files, `site/template.html`, the local stylesheet, the generated image assets, and the bundled WOFF2 fonts. It writes all 12 localized routes plus `404.html`, `robots.txt`, and `sitemap.xml` to `site/dist/`. The script prints any blank configuration values and their visible fallbacks.

To preview locally without a dependency:

```sh
node -e "const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const root=path.resolve('site/dist');http.createServer((req,res)=>{let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(p.endsWith('/'))p+='index.html';let f=path.resolve(root,'.'+p);if(!f.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(f,(e,b)=>{if(e){res.writeHead(404).end(fs.readFileSync(path.join(root,'404.html')));return}const ext=path.extname(f);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.xml':'application/xml','.txt':'text/plain'})[ext]||'application/octet-stream');res.end(b)})}).listen(4174,'127.0.0.1')"
```

Open `http://127.0.0.1:4174/`. Stop the process with Ctrl+C.

## Image conversion

The checked-in conversions were made with FFmpeg (`ffmpeg`, built with `libwebp`). From the repository root, recreate them with:

```sh
mkdir -p site/assets-src/generated
ffmpeg -hide_banner -loglevel error -y -i site/assets-src/hero.png -vf "scale=900:-2:flags=lanczos" -frames:v 1 -c:v libwebp -quality 80 -compression_level 6 site/assets-src/generated/hero-900.webp
ffmpeg -hide_banner -loglevel error -y -i site/assets-src/hero.png -vf "scale=1800:-2:flags=lanczos" -frames:v 1 -c:v libwebp -quality 78 -compression_level 6 site/assets-src/generated/hero-1800.webp
ffmpeg -hide_banner -loglevel error -y -i site/assets-src/hero.png -vf "scale=1200:675:flags=lanczos,crop=1200:630" -frames:v 1 -q:v 3 site/assets-src/generated/og-image.jpg
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=96:96:flags=lanczos" -frames:v 1 -c:v libwebp -quality 90 -compression_level 6 site/assets-src/generated/logo-96.webp
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=32:32:flags=lanczos" -frames:v 1 site/assets-src/generated/favicon.png
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=180:180:flags=lanczos" -frames:v 1 site/assets-src/generated/apple-touch-icon.png
```

Current output sizes:

| File | Size |
|---|---:|
| `hero-900.webp` | 61,056 bytes |
| `hero-1800.webp` | 159,356 bytes |
| `og-image.jpg` | 192,250 bytes |
| `logo-96.webp` | 1,488 bytes |
| `favicon.png` | 1,946 bytes |
| `apple-touch-icon.png` | 35,616 bytes |

The 900 px and 1800 px hero images are both under 300 KB. `node site/build.mjs` enforces that limit.

## Fonts and licenses

The self-hosted WOFF2 files are subsets for the scripts used by the site: variable Latin Fraunces and DM Sans, and regular Noto Sans Khmer and Noto Sans Thai. They were obtained from `fontsource/font-files` at commit `2ffd3aa25908df6ed1c864de40ce53e2ae1076d1`. The matching SIL Open Font License 1.1 texts from `google/fonts` are included under `site/assets-src/fonts/licenses/` and copied into `site/dist/fonts/licenses/` with the font files. No font is requested from a third-party host at runtime.

## Production deployment by operations

Do not replace the existing `truesignal.cc` site until its current owner and use have been confirmed. A request without a `Host` header previously received `401`; identify who owns the existing site and whether it is still used before changing Caddy routes. Back up the existing website files and `/etc/caddy/Caddyfile` first.

Review `deploy/Caddyfile.example` and merge its `truesignal.cc` and `www.truesignal.cc` site block into the existing Caddyfile; do not replace the whole configuration. The example uses the Cloudflare Origin Certificate at `/etc/caddy/certs/truesignal-origin.pem` and `/etc/caddy/certs/truesignal-origin.key`. Keep Cloudflare in Full (strict) mode. Confirm that this Caddy configuration is approved by the existing site's owner before switching the `current` symlink or reloading Caddy.

Release-based copy and symlink switch (run from a reviewed repository checkout on the server):

```sh
release="$(date -u +%Y%m%d%H%M%S)"
sudo mkdir -p "/var/www/truesignal/releases/$release"
sudo cp -a site/dist/. "/var/www/truesignal/releases/$release/"
sudo ln -s "/var/www/truesignal/releases/$release" /var/www/truesignal/current.new
sudo mv -Tf /var/www/truesignal/current.new /var/www/truesignal/current
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The Caddy configuration serves `/var/www/truesignal/current`, caches HTML for 5 minutes and unhashed fonts/images for 7 days, and serves `404.html` with status 404 for unknown paths. Verify `/`, `/km/`, `/th/`, `/zh/`, all privacy and terms routes, the TLS certificate, and response headers after the approved change.

### Roll back

Keep the previous release directory and record its path before switching. To roll back, atomically point `current` to that release, then validate and reload Caddy:

```sh
sudo ln -s /var/www/truesignal/releases/<PREVIOUS_RELEASE> /var/www/truesignal/current.rollback
sudo mv -Tf /var/www/truesignal/current.rollback /var/www/truesignal/current
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If the Caddyfile was changed, restore its backup before validation and reload. For Docker-managed Caddy, validate and reload through the running Caddy container. Do not delete the backup or prior release until the rollback window has closed.

## Configuration still to complete

`site/site.config.json` currently leaves `contactEmail` blank, so pages show `[CONTACT_EMAIL]`. `miniAppShortName` is intentionally blank and the launch link therefore uses `https://t.me/HakuStoryBot?startapp`. Before public launch, the operator should confirm the chosen Bot deep link and fill the contact email. The terms page also visibly marks `[OPERATOR_LEGAL_DETAILS]` and `[GOVERNING_LAW]` for legal review; no registration or jurisdiction information has been invented.

