# Haku public website

Static, five-language website for `truesignal.cc`, ordered `en`, `vi`, `zh`, `km`, `th`. The committed `site/dist/` is the deployment artifact; the server does not need Node, npm, fonts, or image tools to serve it.

## Build and verify

From the repository root:

```sh
node site/build.mjs
node site/check.mjs
```

`site/build.mjs` reads `site/site.config.json`, the locale JSON files, `site/template.html`, the local stylesheet, the generated image assets, and the bundled WOFF2 fonts. It requires every locale to have exactly the English key set and writes all 15 localized routes plus `404.html`, `robots.txt`, and `sitemap.xml` to `site/dist/`. The script prints any blank configuration values and their visible fallbacks.

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
ffmpeg -hide_banner -loglevel error -y -i site/assets-src/hero.png -frames:v 1 -c:v libwebp -quality 78 -compression_level 6 site/assets-src/generated/hero-1672.webp
ffmpeg -hide_banner -loglevel error -y -i site/assets-src/hero.png -vf "scale=1200:675:flags=lanczos,crop=1200:630" -frames:v 1 -q:v 3 site/assets-src/generated/og-image.jpg
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=96:96:flags=lanczos" -frames:v 1 -c:v libwebp -quality 90 -compression_level 6 site/assets-src/generated/logo-96.webp
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=32:32:flags=lanczos" -frames:v 1 site/assets-src/generated/favicon.png
ffmpeg -hide_banner -loglevel error -y -i bot-assets/haku-avatar-640.png -vf "scale=180:180:flags=lanczos" -frames:v 1 site/assets-src/generated/apple-touch-icon.png
```

Current output sizes:

| File | Size |
|---|---:|
| `hero-900.webp` | 61,056 bytes |
| `hero-1672.webp` | 142,858 bytes |
| `og-image.jpg` | 192,250 bytes |
| `logo-96.webp` | 1,488 bytes |
| `favicon.png` | 1,946 bytes |
| `apple-touch-icon.png` | 35,616 bytes |

The 2x hero is encoded at the source's native 1672 px width; do not upscale it. If a wider source replaces `hero.png`, regenerate the 2x file at that width and update the `srcset` descriptor in `site/build.mjs`. The 900 px and 1672 px hero images are both under 300 KB. `node site/build.mjs` enforces that limit.

## Fonts and licenses

The self-hosted WOFF2 files are subsets for the scripts used by the site: variable Latin and Vietnamese Fraunces for titles; Be Vietnam Pro Vietnamese and Latin subsets at 400, 600, and 700 for Vietnamese interface text; variable Latin DM Sans for other Latin text; and Noto Sans Khmer and Noto Sans Thai in regular (400) and semibold (600). All font files were obtained from `fontsource/font-files` at commit `2ffd3aa25908df6ed1c864de40ce53e2ae1076d1`. `site/check.mjs` pins the Vietnamese font assets by SHA-256, parses each WOFF2 `cmap` table, and verifies that every character used by the Vietnamese pages is present in Fraunces and in each Be Vietnam Pro weight. The matching SIL Open Font License 1.1 texts are included under `site/assets-src/fonts/licenses/` and copied into `site/dist/fonts/licenses/`. No font is requested from a third-party host at runtime.

## Production deployment by operations

The production host uses the existing systemd-managed Caddy 2.6.2 service. Back up `/etc/caddy/Caddyfile` and the current website before changing either. Merge only the `truesignal.cc, www.truesignal.cc` block from `deploy/Caddyfile.example`; do not replace unrelated site blocks. Caddy uses automatic HTTPS, and Cloudflare remains in Full (strict) mode.

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

The Caddy configuration serves `/var/www/truesignal/current`, uses short caching for HTML and immutable caching for assets, and serves the static 404 page for unknown paths. Verify `/`, `/vi/`, `/zh/`, `/km/`, `/th/`, all privacy and terms routes, the automatic TLS certificate, and response headers after the approved change.

### Roll back

Keep the previous release directory and record its path before switching. To roll back, atomically point `current` to that release, then validate and reload Caddy:

```sh
sudo ln -s /var/www/truesignal/releases/<PREVIOUS_RELEASE> /var/www/truesignal/current.rollback
sudo mv -Tf /var/www/truesignal/current.rollback /var/www/truesignal/current
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If a previous site configuration was replaced, restore its backup as well. Do not delete the backup or prior release until the rollback window has closed.

## Configuration still to complete

`contactEmail` is `hello@truesignal.cc`, and the blank `miniAppShortName` intentionally produces `https://t.me/HakuStoryBot?startapp`. Legal operator and governing-law fields remain unset and are omitted from generated pages instead of exposing placeholders. Counsel should supply them when confirmed; no registration or jurisdiction information has been invented.
