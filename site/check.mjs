import { access, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

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

const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];

function readUIntBase128(bytes, state, label) {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (state.offset >= bytes.length) throw new Error(`${label}: truncated UIntBase128`);
    const byte = bytes[state.offset++];
    if (index === 0 && byte === 0x80) throw new Error(`${label}: invalid UIntBase128 leading zero`);
    if (value > 0x01ffffff) throw new Error(`${label}: UIntBase128 overflow`);
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error(`${label}: UIntBase128 exceeds five bytes`);
}

function readWoff2Cmap(bytes, label) {
  if (bytes.readUInt32BE(0) !== 0x774f4632) throw new Error(`${label}: not a WOFF2 file`);
  const state = { offset: 48 };
  const tables = [];
  for (let index = 0; index < bytes.readUInt16BE(12); index++) {
    const flags = bytes[state.offset++];
    const tagIndex = flags & 0x3f;
    let tag = WOFF2_TAGS[tagIndex];
    if (tagIndex === 63) {
      tag = bytes.subarray(state.offset, state.offset + 4).toString('ascii');
      state.offset += 4;
    }
    const originalLength = readUIntBase128(bytes, state, label);
    const transformVersion = flags >>> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? transformVersion !== 3 : transformVersion !== 0;
    const storedLength = transformed ? readUIntBase128(bytes, state, label) : originalLength;
    tables.push({ tag, storedLength });
  }
  const compressedLength = bytes.readUInt32BE(20);
  const data = brotliDecompressSync(bytes.subarray(state.offset, state.offset + compressedLength));
  let dataOffset = 0;
  let cmap;
  for (const table of tables) {
    if (dataOffset + table.storedLength > data.length) throw new Error(`${label}: table data exceeds decompressed WOFF2 data`);
    if (table.tag === 'cmap') cmap = data.subarray(dataOffset, dataOffset + table.storedLength);
    dataOffset += table.storedLength;
  }
  if (dataOffset !== data.length) throw new Error(`${label}: decompressed WOFF2 length does not match its table directory`);
  if (!cmap) throw new Error(`${label}: cmap table is missing`);
  return cmap;
}

function format4Has(cmap, offset, codePoint) {
  if (codePoint > 0xffff) return false;
  const length = cmap.readUInt16BE(offset + 2);
  const segmentCount = cmap.readUInt16BE(offset + 6) / 2;
  const endBase = offset + 14;
  const startBase = endBase + segmentCount * 2 + 2;
  const deltaBase = startBase + segmentCount * 2;
  const rangeBase = deltaBase + segmentCount * 2;
  for (let index = 0; index < segmentCount; index++) {
    const end = cmap.readUInt16BE(endBase + index * 2);
    if (codePoint > end) continue;
    const start = cmap.readUInt16BE(startBase + index * 2);
    if (codePoint < start) return false;
    const delta = cmap.readInt16BE(deltaBase + index * 2);
    const rangePosition = rangeBase + index * 2;
    const rangeOffset = cmap.readUInt16BE(rangePosition);
    if (!rangeOffset) return ((codePoint + delta) & 0xffff) !== 0;
    const glyphPosition = rangePosition + rangeOffset + (codePoint - start) * 2;
    if (glyphPosition + 2 > offset + length) return false;
    const glyph = cmap.readUInt16BE(glyphPosition);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

function format12Has(cmap, offset, codePoint) {
  const groups = cmap.readUInt32BE(offset + 12);
  for (let index = 0; index < groups; index++) {
    const group = offset + 16 + index * 12;
    const start = cmap.readUInt32BE(group);
    if (codePoint < start) return false;
    const end = cmap.readUInt32BE(group + 4);
    if (codePoint <= end) return cmap.readUInt32BE(group + 8) + codePoint - start !== 0;
  }
  return false;
}

function cmapHas(cmap, codePoint) {
  const seen = new Set();
  for (let index = 0; index < cmap.readUInt16BE(2); index++) {
    const record = 4 + index * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const offset = cmap.readUInt32BE(record + 4);
    if (seen.has(offset)) continue;
    seen.add(offset);
    const format = cmap.readUInt16BE(offset);
    if (format === 4 && format4Has(cmap, offset, codePoint)) return true;
    if (format === 12 && format12Has(cmap, offset, codePoint)) return true;
  }
  return false;
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
for (const file of ['404.html', 'robots.txt', 'sitemap.xml', 'styles.css', 'assets/hero-900.webp', 'assets/hero-1672.webp', 'fonts/fraunces-vietnamese.woff2', 'fonts/be-vietnam-pro-vietnamese-400.woff2', 'fonts/be-vietnam-pro-latin-400.woff2', 'fonts/be-vietnam-pro-vietnamese-600.woff2', 'fonts/be-vietnam-pro-latin-600.woff2', 'fonts/be-vietnam-pro-vietnamese-700.woff2', 'fonts/be-vietnam-pro-latin-700.woff2', 'fonts/licenses/be-vietnam-pro-OFL.txt', 'fonts/noto-sans-khmer-600.woff2', 'fonts/noto-sans-thai-600.woff2', 'assets/og-image.jpg', 'assets/logo-96.webp', 'assets/favicon.png', 'assets/apple-touch-icon.png']) {
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
  'fraunces.woff2': '7f9d191d999336d3b9790afa72e1358e50a13b06d4f289341e92a311967a80f9',
  'fraunces-vietnamese.woff2': 'ce7b18aac7371cde4a740e54e252e9f02de67ff2ed444b18d1d04e66f50edeb0',
  'be-vietnam-pro-latin-400.woff2': '03d1b589cff172e1a670b3573e731d3380bc326f80cf83b0d3504e3188e2e074',
  'be-vietnam-pro-latin-600.woff2': '9503dec2a7c532c8331e9600bcafea287a4fd208573b8668d85ab8d8de1863c7',
  'be-vietnam-pro-latin-700.woff2': 'a193dd87699bd2e18ddf72dc271493ea82a23dad9f5c334d9f2a257b1e05fc30',
  'be-vietnam-pro-vietnamese-400.woff2': 'dc085e2fba3414e5c5bf1e6172f921a9f81c5859946a4ed3d63c1e470d96a9e2',
  'be-vietnam-pro-vietnamese-600.woff2': '97658c6f9a384f29a3005c3d96e2a0d1c810192cf68979071c290f5a377a9f99',
  'be-vietnam-pro-vietnamese-700.woff2': '4f58af2d1c3e28a9ba14c51c82db2751d78344b75bdcb34de24a1031ebe59da6'
};
for (const [name, expected] of Object.entries(fontHashes)) {
  const bytes = await readFile(join(DIST, 'fonts', name));
  assert(createHash('sha256').update(bytes).digest('hex') === expected, `${name} matches its pinned release asset`);
}

const requiredVietnamese = 'ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư';
const viCopy = JSON.parse(await readFile(join(ROOT, 'locales', 'vi.json'), 'utf8'));
const viPageCopy = Object.entries(viCopy).map(([key, value]) => key === 'privacyLink' ? value.replace(/\s*→\s*$/, '') : value).join('');
const viCharacters = new Set([...(viPageCopy + requiredVietnamese + requiredVietnamese.toLocaleUpperCase('vi')).normalize('NFC')].filter((char) => !/\s/u.test(char)));
const fontCmaps = Object.fromEntries(await Promise.all(Object.keys(fontHashes).map(async (name) => [name, readWoff2Cmap(await readFile(join(DIST, 'fonts', name)), name)])));
for (const char of viCharacters) {
  const codePoint = char.codePointAt(0);
  assert(cmapHas(fontCmaps['fraunces.woff2'], codePoint) || cmapHas(fontCmaps['fraunces-vietnamese.woff2'], codePoint), `Fraunces cmap covers Vietnamese page character ${char}`);
  for (const weight of [400, 600, 700]) {
    assert(cmapHas(fontCmaps[`be-vietnam-pro-latin-${weight}.woff2`], codePoint) || cmapHas(fontCmaps[`be-vietnam-pro-vietnamese-${weight}.woff2`], codePoint), `Be Vietnam Pro ${weight} cmap covers Vietnamese page character ${char}`);
  }
}
for (const weight of [400, 600, 700]) for (const subset of ['vietnamese', 'latin']) {
  assert(new RegExp(`font-family:BeVietnamPro;src:url\\("/fonts/be-vietnam-pro-${subset}-${weight}\\.woff2"\\)[^}]*font-weight:${weight}[^}]*unicode-range:`, 'i').test(css), `Be Vietnam Pro ${subset} ${weight} face has a selectable weight and unicode range`);
}
assert(css.includes('/fonts/fraunces-vietnamese.woff2') && css.includes(':lang(vi){--sans:BeVietnamPro'), 'Vietnamese pages use self-hosted Fraunces titles and Be Vietnam Pro body text');
assert(!css.includes('dm-sans-vietnamese'), 'removed fake DM Sans Vietnamese faces are not referenced');
assert(!(await readFile(join(DIST, 'vi', 'index.html'), 'utf8')).includes('→'), 'decorative privacy arrow is SVG, not a fallback font glyph');
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
