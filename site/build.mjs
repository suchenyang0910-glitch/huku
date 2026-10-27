import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const LOCALES = ['en', 'km', 'th', 'zh'];
const PAGES = ['home', 'privacy', 'terms'];
const CONFIG_PATH = join(ROOT, 'site.config.json');
const GENERATED = join(ROOT, 'assets-src', 'generated');
const CONFIG_KEYS = ['botUsername', 'miniAppShortName', 'operatorName', 'contactEmail', 'retentionDays', 'siteOrigin'];

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function localPath(locale, page) {
  const prefix = locale === 'en' ? '' : `${locale}/`;
  return page === 'home' ? `/${prefix}` : `/${prefix}${page}/`;
}

function absoluteUrl(origin, path) {
  return new URL(path, `${origin}/`).href;
}

function hreflangLinks(origin, page) {
  const links = LOCALES.map((locale) => `  <link rel="alternate" hreflang="${locale}" href="${escapeHtml(absoluteUrl(origin, localPath(locale, page)))}">`);
  links.push(`  <link rel="alternate" hreflang="x-default" href="${escapeHtml(absoluteUrl(origin, localPath('en', page)))}">`);
  return links.join('\n');
}

function openUrl(config) {
  const bot = encodeURIComponent(config.botUsername || '[BOT_USERNAME]');
  const shortName = String(config.miniAppShortName || '').trim();
  return shortName
    ? `https://t.me/${bot}/${encodeURIComponent(shortName)}`
    : `https://t.me/${bot}?startapp`;
}

function languageMenu(locale, page, copy) {
  const labels = { en: 'EN', km: 'ខ្មែរ', th: 'ไทย', zh: '中文' };
  return `<details class="language-menu"><summary aria-label="${escapeHtml(copy.languageMenu)}"><span>${labels[locale]}</span><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="m3.5 6 4.5 4 4.5-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="language-options">${LOCALES.map((code) => `<a href="${localPath(code, page)}" lang="${code}"${code === locale ? ' aria-current="page"' : ''}>${labels[code]}</a>`).join('')}</div></details>`;
}

function header(locale, page, copy, config, launch) {
  const home = localPath(locale, 'home');
  const how = page === 'home' ? '#how-it-works' : `${home}#how-it-works`;
  const privacy = page === 'home' ? '#privacy' : localPath(locale, 'privacy');
  return `<header class="site-header"><a class="brand" href="${home}" aria-label="Haku ${escapeHtml(copy.home)}"><img src="/assets/logo-96.webp" alt="" width="48" height="48"><span class="brand-name">Haku</span></a>${languageMenu(locale, page, copy)}<nav class="top-nav" aria-label="${escapeHtml(copy.navLabel)}"><a href="${how}">${escapeHtml(copy.how)}</a><a href="${privacy}">${escapeHtml(copy.privacy)}</a><a class="button button-primary" data-open-haku href="${escapeHtml(launch)}">${escapeHtml(copy.open)}</a></nav></header>`;
}

function footer(locale, copy, config) {
  const contactEmail = String(config.contactEmail || '').trim();
  const emailText = contactEmail ? escapeHtml(contactEmail) : '<span class="placeholder">[CONTACT_EMAIL]</span>';
  const operator = String(config.operatorName || '').trim();
  const operatorText = operator ? escapeHtml(operator) : '<span class="placeholder">[OPERATOR_NAME]</span>';
  return `<footer class="site-footer"><div class="footer-copy"><p>${escapeHtml(copy.disclaimer)}</p><p>© 2026 ${operatorText}</p></div><nav class="footer-links" aria-label="${escapeHtml(copy.navLabel)}"><a href="${localPath(locale, 'privacy')}">${escapeHtml(copy.privacy)}</a><a href="${localPath(locale, 'terms')}">${escapeHtml(copy.terms)}</a><a href="mailto:${escapeHtml(contactEmail || '[CONTACT_EMAIL]')}">${escapeHtml(copy.contact)} ${emailText}</a></nav></footer>`;
}

const botanical = `<svg class="botanical botanical-hero" viewBox="0 0 150 190" aria-hidden="true" focusable="false" width="150" height="190"><path d="M8 184c29-34 35-77 16-126M25 123c-20-4-29-18-23-34 18 0 29 11 23 34Zm4-19c17-13 20-30 8-43-15 10-18 26-8 43Zm-6-33c-17-12-21-28-10-42 16 9 21 25 10 42Zm18-18c16-12 19-27 9-40-15 8-20 23-9 40Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const bannerBotanical = `<svg class="botanical" viewBox="0 0 140 170" aria-hidden="true" focusable="false" width="140" height="170"><path d="M136 167c-20-33-20-72-3-117m-9 82c-18-7-24-22-15-38 17 4 24 18 15 38Zm-1-23c-17-9-22-24-12-38 16 6 22 21 12 38Zm2-24c-14-12-16-27-4-39 14 9 17 24 4 39Zm-6-23c12-13 11-27-2-37-12 10-13 24 2 37Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function stepIcon(kind) {
  const paths = {
    talk: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v5a3.5 3.5 0 0 1-3.5 3.5H11l-4.5 4v-4.2A3.5 3.5 0 0 1 4 10.5z"/><circle cx="9" cy="8" r=".7"/><circle cx="12" cy="8" r=".7"/><circle cx="15" cy="8" r=".7"/>',
    book: '<path d="M12 6.2c-2.4-2.1-5.2-2.8-8-2.2v14c2.8-.6 5.6.1 8 2.2 2.4-2.1 5.2-2.8 8-2.2V4c-2.8-.6-5.6.1-8 2.2Z"/><path d="M12 6.2v14"/>',
    leaf: '<path d="M19.5 4.5C10 4.3 5 7.8 5 13a5 5 0 0 0 5 5c5.2 0 8.7-5 8.5-13.5Z"/><path d="M3 21c3.4-5 6.7-8 12-11"/><path d="M10 13c1.4.5 2.6 1.5 3.2 3"/>'
  };
  return `<svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}

function homeContent(copy, config, launch, locale) {
  const username = String(config.botUsername || '').trim();
  const usernameText = username ? `@${escapeHtml(username.replace(/^@/, ''))}` : '<span class="placeholder">[@BOT_USERNAME]</span>';
  const email = String(config.contactEmail || '').trim();
  const contactText = email ? escapeHtml(email) : '<span class="placeholder">[CONTACT_EMAIL]</span>';
  return `<div class="home-main"><section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="eyebrow">${escapeHtml(copy.eyebrow)}</p><h1 id="hero-title">${escapeHtml(copy.heroTitle)}</h1><p class="hero-description">${escapeHtml(copy.heroDescription)}</p><div class="hero-actions"><a class="button button-primary" data-open-haku href="${escapeHtml(launch)}">${escapeHtml(copy.open)}<svg class="button-arrow" viewBox="0 0 20 20" aria-hidden="true" focusable="false" width="19" height="19"><path d="M3 10h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></a><a class="bot-handle" href="https://t.me/${encodeURIComponent(username || '[BOT_USERNAME]')}">${escapeHtml(copy.continue)} ${usernameText}</a></div>${botanical}</div><div class="hero-art"><img class="hero-image" src="/assets/hero-900.webp" srcset="/assets/hero-900.webp 900w, /assets/hero-1672.webp 1672w" sizes="(max-width: 900px) 100vw, 61vw" width="900" height="506" alt="${escapeHtml(copy.heroAlt)}" fetchpriority="high"></div></section><section class="steps-section" id="how-it-works" aria-labelledby="steps-title"><h2 id="steps-title">${escapeHtml(copy.calmerTitle)}</h2><p class="section-lead">${escapeHtml(copy.calmerSubtitle)}</p><div class="steps"><article class="step"><span class="step-number" aria-hidden="true">1</span>${stepIcon('talk')}<div><h3>${escapeHtml(copy.stepOneTitle)}</h3><p>${escapeHtml(copy.stepOneText)}</p></div></article><article class="step"><span class="step-number" aria-hidden="true">2</span>${stepIcon('book')}<div><h3>${escapeHtml(copy.stepTwoTitle)}</h3><p>${escapeHtml(copy.stepTwoText)}</p></div></article><article class="step"><span class="step-number" aria-hidden="true">3</span>${stepIcon('leaf')}<div><h3>${escapeHtml(copy.stepThreeTitle)}</h3><p>${escapeHtml(copy.stepThreeText)}</p></div></article></div></section><section class="privacy-band" id="privacy" aria-labelledby="privacy-banner-title"><img class="privacy-logo" src="/assets/logo-96.webp" alt="" width="76" height="76" loading="lazy"><div class="privacy-copy"><h2 id="privacy-banner-title">${escapeHtml(copy.privacyBannerTitle)}</h2><p>${escapeHtml(copy.privacyBannerText)}</p></div><a class="privacy-link" href="${localPath(locale, 'privacy')}">${escapeHtml(copy.privacyLink)}</a>${bannerBotanical}</section><p class="visually-hidden">${escapeHtml(contactText)}</p></div>`;
}

function contactMarkup(copy, config) {
  const email = String(config.contactEmail || '').trim();
  const visible = email ? escapeHtml(email) : '<span class="placeholder">[CONTACT_EMAIL]</span>';
  const link = `<a href="mailto:${escapeHtml(email || '[CONTACT_EMAIL]')}">${visible}</a>`;
  return escapeHtml(copy.contactText).replace('{contactEmail}', link);
}

function legalContent(copy, page, config) {
  if (page === 'privacy') {
    const parts = [
      `<section><h2>${escapeHtml(copy.answersTitle)}</h2><p>${escapeHtml(copy.answersText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.accountTitle)}</h2><p>${escapeHtml(copy.accountText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.retentionTitle)}</h2><p>${escapeHtml(copy.retentionText).replace('{retentionDays}', String(config.retentionDays))}</p></section>`,
      `<section><h2>${escapeHtml(copy.choicesTitle)}</h2><p>${escapeHtml(copy.choicesText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.cookiesTitle)}</h2><p>${escapeHtml(copy.cookiesText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.logsTitle)}</h2><p>${escapeHtml(copy.logsText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.adminTitle)}</h2><p>${escapeHtml(copy.adminText)}</p></section>`,
      `<section><h2>${escapeHtml(copy.contactTitle)}</h2><p>${contactMarkup(copy, config)}</p></section>`
    ];
    return `<article class="page-main"><h1>${escapeHtml(copy.privacyPageTitle)}</h1><p class="page-intro">${escapeHtml(copy.privacyIntro)}</p><div class="prose">${parts.join('')}</div></article>`;
  }
  const parts = [
    `<section><h2>${escapeHtml(copy.termsPurposeTitle)}</h2><p>${escapeHtml(copy.termsPurposeText)}</p></section>`,
    `<section><h2>${escapeHtml(copy.termsTelegramTitle)}</h2><p>${escapeHtml(copy.termsTelegramText)}</p></section>`,
    `<section><h2>${escapeHtml(copy.termsChangesTitle)}</h2><p>${escapeHtml(copy.termsChangesText)}</p></section>`
  ];
  const placeholders = `<div class="terms-placeholders"><p>${escapeHtml(copy.operatorDetails).replace('[OPERATOR_LEGAL_DETAILS]', '<span class="placeholder">[OPERATOR_LEGAL_DETAILS]</span>')}</p><p>${escapeHtml(copy.governingLaw).replace('[GOVERNING_LAW]', '<span class="placeholder">[GOVERNING_LAW]</span>')}</p></div>`;
  return `<article class="page-main"><h1>${escapeHtml(copy.termsPageTitle)}</h1><p class="page-intro">${escapeHtml(copy.termsIntro)}</p><div class="prose">${parts.join('')}<section>${placeholders}</section></div></article>`;
}

async function loadLocale(locale) {
  const copy = JSON.parse(await readFile(join(ROOT, 'locales', `${locale}.json`), 'utf8'));
  for (const [key, value] of Object.entries(copy)) if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing locale value ${locale}.${key}`);
  return copy;
}

function render(template, vars) {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Missing template value: ${key}`);
    return vars[key];
  });
}

async function writeRoute(route, html) {
  const target = route === '/' ? join(DIST, 'index.html') : join(DIST, route.slice(1), 'index.html');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
}

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
for (const key of CONFIG_KEYS) if (!(key in config)) throw new Error(`Missing config key: ${key}`);
if (!Number.isInteger(Number(config.retentionDays)) || Number(config.retentionDays) < 1) throw new Error('retentionDays must be a positive integer');
let origin;
try { origin = new URL(String(config.siteOrigin)).origin; } catch { throw new Error('siteOrigin must be an absolute URL'); }
if (!origin.startsWith('https://')) throw new Error('siteOrigin must use HTTPS');

const template = await readFile(join(ROOT, 'template.html'), 'utf8');
const style = await readFile(join(ROOT, 'styles.css'), 'utf8');
const fontNames = ['fraunces', 'dm-sans', 'noto-sans-khmer', 'noto-sans-khmer-600', 'noto-sans-thai', 'noto-sans-thai-600'];
const fontLicenses = ['fraunces', 'dm-sans', 'noto-sans-khmer', 'noto-sans-thai'];
const assetNames = ['hero-900.webp', 'hero-1672.webp', 'og-image.jpg', 'logo-96.webp', 'favicon.png', 'apple-touch-icon.png'];
for (const file of [...fontNames.map((name) => join(ROOT, 'assets-src', 'fonts', `${name}.woff2`)), ...assetNames.map((name) => join(GENERATED, name))]) {
  try { await stat(file); } catch { throw new Error(`Missing generated asset ${file}. See site/README.md for the asset conversion commands.`); }
}
for (const name of ['hero-900.webp', 'hero-1672.webp']) {
  const info = await stat(join(GENERATED, name));
  if (info.size > 300 * 1024) throw new Error(`${name} must be no larger than 300 KB (currently ${info.size} bytes)`);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'assets'), { recursive: true });
await mkdir(join(DIST, 'fonts', 'licenses'), { recursive: true });
await writeFile(join(DIST, 'styles.css'), style, 'utf8');
for (const name of assetNames) await cp(join(GENERATED, name), join(DIST, 'assets', name));
for (const name of fontNames) await cp(join(ROOT, 'assets-src', 'fonts', `${name}.woff2`), join(DIST, 'fonts', `${name}.woff2`));
for (const name of fontLicenses) await cp(join(ROOT, 'assets-src', 'fonts', 'licenses', `${name.replaceAll('-', '')}-OFL.txt`), join(DIST, 'fonts', 'licenses', `${name}-OFL.txt`));

const launch = openUrl(config);
const localeCopies = Object.fromEntries(await Promise.all(LOCALES.map(async (locale) => [locale, await loadLocale(locale)])));
const sitemapUrls = [];
for (const locale of LOCALES) {
  const copy = localeCopies[locale];
  for (const page of PAGES) {
    const route = localPath(locale, page);
    const canonical = absoluteUrl(origin, route);
    const title = page === 'home' ? copy.titleHome : page === 'privacy' ? copy.titlePrivacy : copy.titleTerms;
    const description = page === 'home' ? copy.descriptionHome : page === 'privacy' ? copy.descriptionPrivacy : copy.descriptionTerms;
    const preload = page === 'home' ? '  <link rel="preload" as="image" href="/assets/hero-900.webp" imagesrcset="/assets/hero-900.webp 900w, /assets/hero-1672.webp 1672w" imagesizes="(max-width: 900px) 100vw, 61vw">' : '';
    const content = page === 'home' ? homeContent(copy, config, launch, locale) : legalContent(copy, page, config);
    const html = render(template, {
      lang: locale,
      title: escapeHtml(title),
      description: escapeHtml(description),
      canonical: escapeHtml(canonical),
      hreflang: hreflangLinks(origin, page),
      preload,
      siteOrigin: escapeHtml(origin),
      pageClass: page === 'home' ? 'page-home' : `page-${page}`,
      skip: escapeHtml(copy.skip),
      header: header(locale, page, copy, config, launch),
      content,
      footer: footer(locale, copy, config)
    });
    await writeRoute(route, html);
    sitemapUrls.push(canonical);
  }
}

const notFoundCopy = localeCopies.en;
const notFoundHtml = render(template, {
  lang: 'en', title: escapeHtml(`404 — ${notFoundCopy.notFoundTitle} · Haku`),
  description: escapeHtml(notFoundCopy.notFoundText), canonical: escapeHtml(absoluteUrl(origin, '/404.html')),
  hreflang: hreflangLinks(origin, 'home'), preload: '', siteOrigin: escapeHtml(origin), pageClass: 'page-404',
  skip: escapeHtml(notFoundCopy.skip), header: header('en', 'terms', notFoundCopy, config, launch),
  content: `<article class="page-main not-found"><h1>${escapeHtml(notFoundCopy.notFoundTitle)}</h1><p class="page-intro">${escapeHtml(notFoundCopy.notFoundText)}</p><a class="button button-primary" href="/">${escapeHtml(notFoundCopy.returnHome)}</a></article>`,
  footer: footer('en', notFoundCopy, config)
});
await writeFile(join(DIST, '404.html'), notFoundHtml, 'utf8');
await writeFile(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, 'utf8');
await writeFile(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n')}\n</urlset>\n`, 'utf8');

const missing = [];
if (!String(config.contactEmail || '').trim()) missing.push('contactEmail — pages show [CONTACT_EMAIL] and a mailto placeholder');
if (!String(config.operatorName || '').trim()) missing.push('operatorName — footer shows [OPERATOR_NAME]');
if (!String(config.botUsername || '').trim()) missing.push('botUsername — launch links show [BOT_USERNAME]');
if (!String(config.miniAppShortName || '').trim()) missing.push('miniAppShortName — optional; using https://t.me/{botUsername}?startapp');
if (missing.length) {
  console.warn('Configuration values not filled:');
  for (const item of missing) console.warn(`- ${item}`);
} else {
  console.log('All required display configuration values are filled.');
}
console.log(`Built ${LOCALES.length * PAGES.length} localized routes, 404.html, robots.txt and sitemap.xml in site/dist.`);
