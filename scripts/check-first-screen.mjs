import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is required: npm install --no-save --package-lock=false playwright');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://mini.localhost').pathname;
    const relative = pathname === '/' ? 'haku.html' : pathname.startsWith('/assets/') ? `public${pathname}` : pathname.slice(1);
    if (relative !== 'haku.html' && !relative.startsWith('public/assets/')) throw new Error('not found');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('not found');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });

const locales = ['en', 'vi', 'zh', 'km', 'th'];
const states = ['unverified', 'verified-unsaved', 'saved'];
const viewports = [{ width: 390, height: 750 }, { width: 360, height: 640 }];

async function openScenario({ locale = 'en', state = 'verified-unsaved', viewport = viewports[0], consentFails = false, telegram = true } = {}) {
  const context = await browser.newContext({ viewport });
  await context.route('https://telegram.org/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript(({ locale, state, consentFails, telegram }) => {
    localStorage.setItem('haku-locale', locale);
    const main = {
      visible: false, text: '', callback: null,
      show() { this.visible = true; }, hide() { this.visible = false; },
      setText(text) { this.text = text; }, onClick(callback) { this.callback = callback; },
      offClick(callback) { if (this.callback === callback) this.callback = null; },
      click() { return this.callback?.(); }, disable() {}, enable() {}, showProgress() {}, hideProgress() {}
    };
    const back = { show() {}, hide() {}, onClick() {}, offClick() {} };
    window.__hakuTest = { authCalls: 0, consentCalls: 0, main };
    if (telegram) window.Telegram = { WebApp: {
        initData: 'signed-test-data',
        initDataUnsafe: { user: { id: 42, first_name: 'Lan', username: 'lan', language_code: locale } },
        MainButton: main, BackButton: back, themeParams: {}, colorScheme: 'light',
        ready() {}, expand() {}, onEvent() {}, isVersionAtLeast() { return true; }
      } };
    window.HAKU_API_BASE = location.origin;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/api/telegram/auth')) {
        window.__hakuTest.authCalls++;
        if (state === 'unverified') return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ user: { id: '42', name: 'Lan', username: 'lan' }, csrfToken: 'csrf' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/telegram/account')) {
        return new Response(state === 'saved' ? JSON.stringify({ id: '42' }) : '{}', { status: state === 'saved' ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/telegram/consent')) {
        window.__hakuTest.consentCalls++;
        return new Response(consentFails ? '{}' : JSON.stringify({ saved: true }), { status: consentFails ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, options);
    };
  }, { locale, state, consentFails, telegram });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
  page.on('response', response => {
    const expectedApiMiss = response.url().includes('/api/telegram/') && [401, 404, 500].includes(response.status());
    if (response.status() >= 400 && !expectedApiMiss) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`http://mini.localhost:${port}/haku.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(telegram => window.__hakuTest && window.__hakuTest.authCalls === (telegram ? 1 : 0), telegram);
  await page.waitForTimeout(20);
  return { context, page, errors };
}

try {
  for (const viewport of viewports) {
    for (const locale of locales) {
      for (const state of states) {
        const { context, page, errors } = await openScenario({ locale, state, viewport });
        const result = await page.evaluate(() => {
          const button = document.querySelector('#start-reading').getBoundingClientRect();
          const panel = document.querySelector('#consent-panel');
          const consent = panel.hidden ? null : panel.getBoundingClientRect();
          return {
            buttonTop: Math.round(button.top), buttonBottom: Math.round(button.bottom),
            consentBottom: consent ? Math.round(consent.bottom) : null,
            overflow: document.documentElement.scrollWidth - innerWidth,
            headerHeight: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
            consentVisible: !panel.hidden
          };
        });
        console.log(`${viewport.width}x${viewport.height} ${locale} ${state}: button ${result.buttonTop}-${result.buttonBottom}px, consent ${result.consentBottom ?? 'hidden'}, overflow ${result.overflow}px`);
        assert.ok(result.buttonBottom <= viewport.height, 'Begin the story must be visible without scrolling');
        assert.equal(result.consentVisible, state === 'verified-unsaved');
        if (viewport.width === 390 && result.consentBottom !== null) assert.ok(result.consentBottom <= viewport.height, 'Consent must be fully visible at 390x750');
        assert.ok(result.overflow <= 0, 'Page must not scroll horizontally');
        assert.ok(result.headerHeight <= 50, 'Mobile header must remain on one row');
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }

  const noTelegram = await openScenario({ telegram: false });
  assert.equal(await noTelegram.page.locator('#consent-panel').isVisible(), false, 'Consent is hidden outside Telegram');
  assert.equal(await noTelegram.page.evaluate(() => window.__hakuTest.main.visible), false, 'MainButton is not called outside Telegram');
  await noTelegram.context.close();

  for (const mode of ['checked', 'unchecked', 'failed']) {
    const { context, page, errors } = await openScenario({ consentFails: mode === 'failed' });
    if (mode === 'unchecked') await page.uncheck('#consent');
    await page.click('#start-reading');
    await page.waitForFunction(() => !document.querySelector('#question-screen').hidden);
    assert.equal(await page.evaluate(() => window.__hakuTest.consentCalls), mode === 'unchecked' ? 0 : 1);
    if (mode === 'failed') assert.equal(await page.locator('#toast').isVisible(), true, 'Consent error remains visible while reading starts');
    assert.deepEqual(errors, []);
    await context.close();
  }

  const { context, page, errors } = await openScenario();
  assert.equal(await page.evaluate(() => window.__hakuTest.main.visible), true, 'MainButton is visible on home');
  await page.click('#language-trigger');
  await page.click('[data-language="vi"]');
  assert.equal(await page.evaluate(() => window.__hakuTest.main.text), 'Bắt đầu câu chuyện');
  await page.uncheck('#consent');
  await page.evaluate(() => window.__hakuTest.main.click());
  await page.waitForFunction(() => !document.querySelector('#question-screen').hidden);
  assert.equal(await page.evaluate(() => window.__hakuTest.main.visible), false, 'MainButton is hidden in questionnaire');
  await page.click('#question-prev');
  assert.equal(await page.evaluate(() => window.__hakuTest.main.visible), true, 'MainButton returns on home');
  await page.click('#user-entry');
  await page.waitForFunction(() => !document.querySelector('#me-view').hidden);
  assert.equal(await page.evaluate(() => window.__hakuTest.main.visible), false, 'MainButton is hidden in My account');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('check-first-screen.mjs: all layout and Telegram MainButton scenarios pass.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
