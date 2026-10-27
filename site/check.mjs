import { access, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const ORIGIN = 'https://truesignal.cc';
const LOCALES = ['en', 'vi', 'zh', 'km', 'th'];
const PAGES = ['home', 'privacy', 'terms'];
let failures = 0;
let assertions = 0;

function assert(condition, message) {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${message}`);
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

function routeFor(locale, page) {
  const prefix = locale === 'en' ? '' : `${locale}/`;
  return page === 'home' ? `/${prefix}` : `/${prefix}${page}/`;
}

function fileForPath(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!clean) return join(DIST, 'index.html');
  let file = resolve(DIST, clean);
  if (!file.startsWith(`${resolve(DIST)}${sep}`)) return null;
  if (pathname.endsWith('/')) file = join(file, 'index.html');
  return file;
}

function getAttr(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] ?? null;
}

const files = await walk(DIST);
const htmlFiles = files.filter((path) => path.endsWith('.html'));
assert(htmlFiles.length === LOCALES.length * PAGES.length + 1, `expected ${LOCALES.length * PAGES.length + 1} HTML pages, found ${htmlFiles.length}`);

const expectedRoutes = [];
for (const locale of LOCALES) for (const page of PAGES) expectedRoutes.push(routeFor(locale, page));
for (const route of expectedRoutes) {
  const target = fileForPath(route);
  try { await access(target); assert(true, `route exists: ${route}`); }
  catch { assert(false, `route exists: ${route}`); }
}
for (const file of ['404.html', 'robots.txt', 'sitemap.xml', 'styles.css', 'assets/hero-900.webp', 'assets/hero-1672.webp', 'fonts/fraunces-vietnamese.woff2', 'fonts/dm-sans-vietnamese-400.woff2', 'fonts/dm-sans-vietnamese-600.woff2', 'fonts/dm-sans-vietnamese-700.woff2', 'fonts/noto-sans-khmer-600.woff2', 'fonts/noto-sans-thai-600.woff2', 'assets/og-image.jpg', 'assets/logo-96.webp', 'assets/favicon.png', 'assets/apple-touch-icon.png']) {
  try { await access(join(DIST, file)); assert(true, `required output exists: ${file}`); }
  catch { assert(false, `required output exists: ${file}`); }
}

const openLinks = new Set();
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const label = relative(DIST, file).replaceAll(sep, '/') || 'index.html';
  const lang = html.match(/<html\b[^>]*\blang="([^"]+)"/i)?.[1];
  assert(LOCALES.includes(lang), `${label} has a supported html lang`);
  assert(/<title>[^<]+<\/title>/i.test(html), `${label} has a title`);
  assert(/<meta\s+name="description"\s+content="[^"]+"/i.test(html), `${label} has a meta description`);
  assert(/<link\s+rel="canonical"\s+href="https:\/\/truesignal\.cc\//i.test(html), `${label} has a self canonical URL`);
  for (const alternate of [...LOCALES, 'x-default']) {
    assert(new RegExp(`<link\\s+rel="alternate"\\s+hreflang="${alternate}"\\s+href="https://truesignal\\.cc/`, 'i').test(html), `${label} has hreflang ${alternate}`);
  }
  assert(!/<script\b/i.test(html), `${label} has no JavaScript`);
  assert(!/\sstyle\s*=/i.test(html), `${label} has no inline styles`);

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  for (let index = 0; index < imgs.length; index++) {
    const tag = imgs[index];
    assert(getAttr(tag, 'alt') !== null, `${label} image ${index + 1} has alt`);
    assert(Number(getAttr(tag, 'width')) > 0, `${label} image ${index + 1} has width`);
    assert(Number(getAttr(tag, 'height')) > 0, `${label} image ${index + 1} has height`);
  }

  for (const match of html.matchAll(/<a\b[^>]*data-open-haku[^>]*>/gi)) {
    const href = getAttr(match[0], 'href');
    try {
      const url = new URL(href);
      assert(url.protocol === 'https:' && url.hostname === 't.me', `${label} Open Haku link goes to t.me`);
      if (href) openLinks.add(href);
    } catch { assert(false, `${label} Open Haku link has a valid t.me URL`); }
  }

  for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
    const href = match[1];
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      assert(html.includes(`id="${id}"`), `${label} anchor target exists: ${href}`);
      continue;
    }
    if (/^(mailto:|https:\/\/t\.me\/)/i.test(href)) continue;
    let pathname;
    try {
      const url = new URL(href, `${ORIGIN}/`);
      if (url.origin !== ORIGIN) { assert(false, `${label} has no third-party navigation: ${href}`); continue; }
      pathname = url.pathname;
    } catch { assert(false, `${label} has a parseable link: ${href}`); continue; }
    const target = fileForPath(pathname);
    try { await access(target); assert(true, `${label} internal link resolves: ${href}`); }
    catch { assert(false, `${label} internal link resolves: ${href}`); }
  }

  for (const match of html.matchAll(/<(?:img|link)\b[^>]*(?:src|href)="([^"]+)"[^>]*>/gi)) {
    const value = match[1];
    if (/^(https?:|mailto:|data:|#)/i.test(value)) continue;
    const pathname = new URL(value, `${ORIGIN}/`).pathname;
    const target = fileForPath(pathname);
    try { await access(target); assert(true, `${label} resource exists: ${value}`); }
    catch { assert(false, `${label} resource exists: ${value}`); }
  }
  for (const match of html.matchAll(/\bsrcset="([^"]+)"/gi)) {
    for (const candidate of match[1].split(',')) {
      const value = candidate.trim().split(/\s+/)[0];
      const target = fileForPath(new URL(value, `${ORIGIN}/`).pathname);
      try { await access(target); assert(true, `${label} srcset resource exists: ${value}`); }
      catch { assert(false, `${label} srcset resource exists: ${value}`); }
    }
  }
}
assert(openLinks.size === 1, `all Open Haku buttons use one common URL (found ${openLinks.size})`);

const css = await readFile(join(DIST, 'styles.css'), 'utf8');
for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
  const value = match[1];
  if (/^https?:/i.test(value)) { assert(false, `CSS has no third-party resources: ${value}`); continue; }
  const target = fileForPath(new URL(value, `${ORIGIN}/`).pathname);
  try { await access(target); assert(true, `CSS resource exists: ${value}`); }
  catch { assert(false, `CSS resource exists: ${value}`); }
}

const fontHashes = {
  'fraunces-vietnamese.woff2': 'ce7b18aac7371cde4a740e54e252e9f02de67ff2ed444b18d1d04e66f50edeb0',
  'dm-sans-vietnamese-400.woff2': '85f46c97652407c4d4b3bb337fc130e8be313a82b18ece1c86d54df37912f050',
  'dm-sans-vietnamese-600.woff2': '85f46c97652407c4d4b3bb337fc130e8be313a82b18ece1c86d54df37912f050',
  'dm-sans-vietnamese-700.woff2': '85f46c97652407c4d4b3bb337fc130e8be313a82b18ece1c86d54df37912f050'
};
for (const [name, expected] of Object.entries(fontHashes)) {
  const bytes = await readFile(join(DIST, 'fonts', name));
  assert(createHash('sha256').update(bytes).digest('hex') === expected, `${name} matches its pinned release asset`);
}

const latin = [[0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6], [0x02da, 0x02dc], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x2000, 0x206f]];
const frauncesVietnamese = [[0x0102, 0x0103], [0x0110, 0x0111], [0x0128, 0x0129], [0x0168, 0x0169], [0x01a0, 0x01a1], [0x01af, 0x01b0], [0x0300, 0x0301], [0x0303, 0x0304], [0x0308, 0x0309], [0x0323, 0x0323], [0x0329, 0x0329], [0x1ea0, 0x1ef9]];
const dmSansVietnamese = [[0x0102, 0x0103], [0x0110, 0x0111], [0x0128, 0x0129], [0x0168, 0x0169], [0x01a0, 0x01a1], [0x01af, 0x01b0], [0x0300, 0x0303], [0x0306, 0x0306], [0x0309, 0x0309], [0x031b, 0x031b], [0x0323, 0x0323], [0x1ea0, 0x1ef9]];
const covered = (char, ranges) => ranges.some(([start, end]) => char.codePointAt(0) >= start && char.codePointAt(0) <= end);
const requiredVietnamese = 'ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư';
for (const char of new Set(requiredVietnamese + requiredVietnamese.toLocaleUpperCase('vi'))) {
  assert(covered(char, frauncesVietnamese), `Fraunces Vietnamese subset covers ${char}`);
  assert(covered(char, dmSansVietnamese), `DM Sans Vietnamese subset covers ${char}`);
}
const viCopy = JSON.parse(await readFile(join(ROOT, 'locales', 'vi.json'), 'utf8'));
const viLetters = new Set([...Object.values(viCopy).join(' ').normalize('NFC')].filter((char) => /\p{Letter}/u.test(char)));
for (const char of viLetters) {
  assert(covered(char, [...latin, ...frauncesVietnamese]), `Fraunces self-hosted files cover Vietnamese page character ${char}`);
  assert(covered(char, [...latin, ...dmSansVietnamese]), `DM Sans self-hosted files cover Vietnamese page character ${char}`);
}
assert(css.includes('/fonts/fraunces-vietnamese.woff2') && css.includes('/fonts/dm-sans-vietnamese-400.woff2') && css.includes('/fonts/dm-sans-vietnamese-600.woff2') && css.includes('/fonts/dm-sans-vietnamese-700.woff2'), 'Vietnamese font subsets are loaded from self-hosted files');
const tokens = Object.fromEntries([...css.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]));
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
function contrast(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + .05) / (b + .05);
}
const contrastPairs = [
  ['ink', 'paper'], ['muted', 'paper'], ['forest', 'paper'], ['ink', 'gold'],
  ['ink', 'forest-soft'], ['white', 'forest'], ['white', 'forest-deep'],
  ['muted', 'surface'], ['placeholder-ink', 'placeholder-bg']
];
const extra = { white: '#ffffff', 'placeholder-ink': '#3d3018', 'placeholder-bg': '#fbf0ce' };
for (const [fg, bg] of contrastPairs) {
  const a = extra[fg] || tokens[fg], b = extra[bg] || tokens[bg];
  assert(Boolean(a && b) && contrast(a, b) >= 4.5, `text contrast ${fg} on ${bg} is at least 4.5:1${a && b ? ` (${contrast(a, b).toFixed(2)}:1)` : ''}`);
}

if (failures) {
  console.error(`${failures} of ${assertions} checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`site/check.mjs: ${assertions} checks passed; all text contrast pairs meet 4.5:1.`);
}
