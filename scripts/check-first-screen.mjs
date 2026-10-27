import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
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
const screenshotDir = path.join(root, 'docs', 'screenshots');
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

async function openScenario({ locale = 'en', state = 'verified-unsaved', viewport = viewports[0], consentFails = false, telegram = true, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport });
  await context.route('https://telegram.org/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript(({ locale, state, consentFails, telegram, colorScheme }) => {
    localStorage.setItem('haku-locale', locale);
    const main = {
      visible: false, text: '', callback: null,
      show() { this.visible = true; }, hide() { this.visible = false; },
      setText(text) { this.text = text; }, onClick(callback) { this.callback = callback; },
      offClick(callback) { if (this.callback === callback) this.callback = null; },
      click() { return this.callback?.(); }, disable() {}, enable() {}, showProgress() {}, hideProgress() {}
    };
    const back = {
      visible: false, callback: null,
      show() { this.visible = true; }, hide() { this.visible = false; },
      onClick(callback) { this.callback = callback; },
      offClick(callback) { if (this.callback === callback) this.callback = null; },
      click() { return this.callback?.(); }
    };
    window.__hakuTest = { authCalls: 0, consentCalls: 0, haptics: 0, main, back };
    if (telegram) window.Telegram = { WebApp: {
        initData: 'signed-test-data',
        initDataUnsafe: { user: { id: 42, first_name: 'Lan', username: 'lan', language_code: locale } },
        MainButton: main, BackButton: back,
        HapticFeedback: { selectionChanged() { window.__hakuTest.haptics++; } },
        themeParams: colorScheme === 'dark' ? { bg_color: '#16231f', section_bg_color: '#293a33', text_color: '#f1f3ed', hint_color: '#bdc9c1' } : {}, colorScheme,
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
  }, { locale, state, consentFails, telegram, colorScheme });
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

  await mkdir(screenshotDir, { recursive: true });
  const dateScenario = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  await dateScenario.page.click('#start-reading');
  await dateScenario.page.click('#answer-date');
  await dateScenario.page.waitForFunction(() => !document.querySelector('#wheel-dialog').hidden);
  const dialogBox = await dateScenario.page.locator('.wheel-picker-sheet').boundingBox();
  assert.ok(dialogBox && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 750, 'date wheel fits in 390x750');
  assert.equal(await dateScenario.page.locator('[role="listbox"]').count(), 3, 'date wheel exposes three listboxes');
  assert.equal(await dateScenario.page.locator('[role="option"][aria-selected="true"]').count(), 3, 'each listbox exposes its selected option');
  await dateScenario.page.screenshot({ path: path.join(screenshotDir, 'task-15-date-wheel-open.png') });
  await dateScenario.page.evaluate(() => window.__hakuTest.back.click());
  assert.equal(await dateScenario.page.locator('#wheel-dialog').isHidden(), true, 'Telegram BackButton closes the date wheel');
  assert.equal(await dateScenario.page.locator('#answer-date').evaluate(element => document.activeElement === element), true, 'closing restores focus to the date field');
  assert.match(await dateScenario.page.locator('#answer-date').textContent(), /选择出生日期/, 'cancel does not commit the initial draft');
  await dateScenario.page.click('#answer-date');
  await dateScenario.page.locator('#date-year-wheel').press('ArrowDown');
  assert.ok(await dateScenario.page.evaluate(() => window.__hakuTest.haptics) > 0, 'wheel selection triggers haptic feedback');
  await dateScenario.page.keyboard.press('Escape');
  assert.equal(await dateScenario.page.locator('#wheel-dialog').isHidden(), true, 'Escape closes the date wheel');
  await dateScenario.page.click('#answer-date');
  await dateScenario.page.locator('#date-month-5').click();
  await dateScenario.page.locator('#date-day-15').click();
  await dateScenario.page.click('#wheel-confirm');
  assert.match(await dateScenario.page.locator('#answer-date').textContent(), /1990.*5.*15/, 'Confirm displays the localized 1990-05-15 date');
  await dateScenario.page.screenshot({ path: path.join(screenshotDir, 'task-15-date-wheel-selected.png') });
  assert.equal(await dateScenario.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'date question does not scroll horizontally');

  await dateScenario.page.click('#answer-date');
  await dateScenario.page.evaluate(() => new Promise(resolve => {
    const year = document.querySelector('#date-year-wheel');
    const month = document.querySelector('#date-month-wheel');
    window.__dateMonthFirstOption = month.firstElementChild;
    year.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    year.scrollTop = (1991 - 1930) * 44;
    setTimeout(() => {
      month.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      month.scrollTop = (8 - 1) * 44;
    }, 50);
    setTimeout(() => year.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })), 100);
    setTimeout(() => {
      month.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
      resolve();
    }, 150);
  }));
  await dateScenario.page.waitForTimeout(220);
  const fastWheelResult = await dateScenario.page.evaluate(() => {
    const month = document.querySelector('#date-month-wheel');
    const centered = month.children[Math.round(month.scrollTop / 44)];
    return {
      month: Number(centered.dataset.value),
      selected: document.querySelector('#date-month-8').getAttribute('aria-selected'),
      sameNode: window.__dateMonthFirstOption === month.firstElementChild
    };
  });
  assert.deepEqual(fastWheelResult, { month: 8, selected: 'true', sameNode: true }, 'settling the year does not redraw or reset an active month wheel');
  await dateScenario.page.click('#wheel-confirm');
  assert.match(await dateScenario.page.locator('#answer-date').textContent(), /1991.*8.*15/, 'fast cross-wheel scrolling confirms the visible August value');

  await dateScenario.page.click('#answer-date');
  await dateScenario.page.evaluate(() => {
    document.querySelector('#date-month-wheel').scrollTop = (11 - 1) * 44;
    document.querySelector('#wheel-confirm').click();
  });
  assert.match(await dateScenario.page.locator('#answer-date').textContent(), /1991.*11.*15/, 'immediate Confirm settles the visible wheel values before committing');
  assert.deepEqual(dateScenario.errors, []);
  await dateScenario.context.close();

  const darkScenario = await openScenario({ locale: 'vi', state: 'saved', viewport: { width: 390, height: 750 }, colorScheme: 'dark' });
  await darkScenario.page.click('#start-reading');
  await darkScenario.page.click('#answer-date');
  assert.equal(await darkScenario.page.evaluate(() => document.documentElement.classList.contains('telegram-dark')), true, 'date wheel follows Telegram dark mode');
  assert.equal(await darkScenario.page.locator('.wheel-picker-sheet').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(41, 58, 51)', 'date wheel uses the raised dark surface');
  assert.deepEqual(darkScenario.errors, []);
  await darkScenario.context.close();

  const timeScenario = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  await timeScenario.page.click('#start-reading');
  await timeScenario.page.click('#answer-date');
  await timeScenario.page.locator('#date-month-5').click();
  await timeScenario.page.locator('#date-day-15').click();
  await timeScenario.page.click('#wheel-confirm');
  await timeScenario.page.selectOption('#answer-place', 'cn');
  await timeScenario.page.click('#question-next');
  assert.equal(await timeScenario.page.locator('#answer-time').textContent(), '选择出生时间', 'empty time field uses the localized placeholder');
  await timeScenario.page.evaluate(() => { window.__timeTrigger = document.querySelector('#answer-time'); });
  await timeScenario.page.click('#answer-time');
  const timeDialogBox = await timeScenario.page.locator('.wheel-picker-sheet').boundingBox();
  assert.ok(timeDialogBox && timeDialogBox.y >= 0 && timeDialogBox.y + timeDialogBox.height <= 750, 'time wheel fits in 390x750');
  assert.equal(await timeScenario.page.locator('[role="listbox"]').count(), 2, 'time wheel exposes two listboxes');
  assert.equal(await timeScenario.page.locator('#time-hour-12').getAttribute('aria-selected'), 'true', 'uncommitted time draft starts at 12');
  assert.equal(await timeScenario.page.locator('#time-minute-0').getAttribute('aria-selected'), 'true', 'uncommitted time draft starts at :00');
  await timeScenario.page.evaluate(() => {
    const hour = document.querySelector('#time-hour-wheel');
    const minute = document.querySelector('#time-minute-wheel');
    hour.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    hour.scrollTop = 23 * 44;
    setTimeout(() => {
      minute.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      minute.scrollTop = 30 * 44;
    }, 50);
    setTimeout(() => hour.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })), 100);
    setTimeout(() => minute.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 })), 150);
  });
  await timeScenario.page.waitForTimeout(75);
  assert.equal(await timeScenario.page.locator('#wheel-dialog').isVisible(), true, 'time dialog stays open while both wheels are moving');
  await timeScenario.page.waitForTimeout(180);
  const settledTime = await timeScenario.page.evaluate(() => Object.fromEntries(['hour', 'minute'].map(kind => {
    const wheel = document.querySelector(`#time-${kind}-wheel`);
    const centered = wheel.children[Math.round(wheel.scrollTop / 44)];
    return [kind, { value: Number(centered.dataset.value), selected: centered.getAttribute('aria-selected') }];
  })));
  assert.deepEqual(settledTime, { hour: { value: 23, selected: 'true' }, minute: { value: 30, selected: 'true' } }, 'hour and minute settle independently at 23:30');
  await timeScenario.page.screenshot({ path: path.join(screenshotDir, 'task-16-time-wheel-open.png') });
  await timeScenario.page.click('#wheel-confirm');
  assert.equal(await timeScenario.page.locator('#answer-time').textContent(), '23:30', 'time Confirm displays 23:30');
  assert.equal(await timeScenario.page.evaluate(() => window.__timeTrigger === document.querySelector('#answer-time')), true, 'time Confirm keeps the same trigger DOM node');
  assert.match(await timeScenario.page.locator('#time-zone-notice').textContent(), /夏令时/, 'China daylight-saving notice updates after time Confirm');
  assert.equal(await timeScenario.page.locator('#time-zone-notice').isVisible(), true, 'daylight-saving notice is visible');
  await timeScenario.page.screenshot({ path: path.join(screenshotDir, 'task-16-time-wheel-selected.png') });
  await timeScenario.page.check('#unknown-time');
  assert.equal(await timeScenario.page.locator('#answer-time').isDisabled(), true, 'unknown birth time disables the time trigger');
  assert.equal(await timeScenario.page.locator('#answer-time').textContent(), '23:30', 'unknown birth time preserves the selected value');
  await timeScenario.page.uncheck('#unknown-time');
  assert.equal(await timeScenario.page.locator('#answer-time').isEnabled(), true, 'clearing unknown birth time re-enables the time trigger');
  await timeScenario.page.click('#question-next');
  assert.equal(await timeScenario.page.locator('#step-label').textContent(), '03', 'confirmed time can continue to the next question');
  assert.equal(await timeScenario.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'time question does not scroll horizontally');
  assert.deepEqual(timeScenario.errors, []);
  await timeScenario.context.close();
  console.log('check-first-screen.mjs: layout, Telegram controls, shared date/time wheel, and screenshots pass.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
