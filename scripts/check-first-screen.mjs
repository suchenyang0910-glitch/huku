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
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

async function openScenario({ locale = 'en', state = 'verified-unsaved', viewport = viewports[0], consentFails = false, profileFails = false, telegram = true, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport });
  await context.route('https://telegram.org/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript(({ locale, state, consentFails, profileFails, telegram, colorScheme }) => {
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
    window.__hakuTest = { authCalls: 0, consentCalls: 0, profilePuts: 0, profileDeletes: 0, profileFails, haptics: 0, main, back };
    if (!localStorage.getItem('__hakuFakeInitialized')) {
      localStorage.setItem('__hakuFakeInitialized', '1');
      if (state === 'saved' || state === 'old-v4') localStorage.setItem('__hakuFakeAccount', JSON.stringify({ telegram_id: '42', locale, consent_version: state === 'old-v4' ? '2026-10-28-v4-reading-profile' : '2026-10-28-v5-ziwei-gender' }));
    }
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
        const account = localStorage.getItem('__hakuFakeAccount');
        const profile = localStorage.getItem('__hakuFakeProfile');
        const saved = account ? JSON.parse(account) : null;
        return new Response(saved ? JSON.stringify({ ...saved, consent_current: saved.consent_version === '2026-10-28-v5-ziwei-gender', profile: profile ? JSON.parse(profile) : null }) : '{}', { status: saved ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/telegram/consent')) {
        window.__hakuTest.consentCalls++;
        if (!consentFails) localStorage.setItem('__hakuFakeAccount', JSON.stringify({ telegram_id: '42', locale, consent_version: '2026-10-28-v5-ziwei-gender' }));
        return new Response(consentFails ? '{}' : JSON.stringify({ saved: true, consent_current: true }), { status: consentFails ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/telegram/profile')) {
        if ((options.method || 'GET') === 'PUT') {
          window.__hakuTest.profilePuts++;
          if (window.__hakuTest.profileFails) return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
          const profile = { ...JSON.parse(options.body), telegram_id: '42', updated_at: new Date().toISOString() };
          localStorage.setItem('__hakuFakeProfile', JSON.stringify(profile));
          return new Response(JSON.stringify(profile), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (options.method === 'DELETE') {
          window.__hakuTest.profileDeletes++;
          localStorage.removeItem('__hakuFakeProfile');
          return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const profile = localStorage.getItem('__hakuFakeProfile');
        return new Response(profile || '{}', { status: profile ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, options);
    };
  }, { locale, state, consentFails, profileFails, telegram, colorScheme });
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

async function completeReading(page, { gender = 'male', unknownTime = false } = {}) {
  await page.click('#start-reading');
  await page.click('#answer-date');
  await page.locator('#date-month-5').click();
  await page.locator('#date-day-15').click();
  await page.click('#wheel-confirm');
  await page.selectOption('#answer-place', 'cn');
  await page.click('#question-next');
  if (unknownTime) await page.check('#unknown-time');
  else {
    await page.click('#answer-time');
    await page.click('#wheel-confirm');
  }
  await page.click('#question-next');
  await page.locator(`[name="answer-gender"][value="${gender}"]`).check();
  await page.click('#question-next');
  for (const name of ['relationship', 'concern', 'duration']) {
    await page.locator(`[name="answer-${name}"]`).first().check();
    await page.click('#question-next');
  }
  await page.waitForFunction(() => window.__hakuTest.profilePuts === 1);
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

  const profileScenario = await openScenario({ locale: 'zh', state: 'verified-unsaved', viewport: { width: 390, height: 750 } });
  await completeReading(profileScenario.page);
  assert.equal(await profileScenario.page.evaluate(() => JSON.parse(localStorage.getItem('__hakuFakeProfile')).birth_date), '1990-05-15', 'completed questionnaire saves the profile');
  await profileScenario.page.reload({ waitUntil: 'domcontentloaded' });
  await profileScenario.page.waitForFunction(() => window.__hakuTest.authCalls === 1 && !document.querySelector('#start-reading').disabled);
  await profileScenario.page.click('#start-reading');
  assert.match(await profileScenario.page.locator('#answer-date').textContent(), /1990.*5.*15/, 'refresh prefills the saved birth date');
  assert.equal(await profileScenario.page.locator('#answer-place').inputValue(), 'cn', 'refresh prefills the saved place');
  await profileScenario.page.click('#question-prev');
  await profileScenario.page.click('#user-entry');
  await profileScenario.page.waitForFunction(() => !document.querySelector('#profile-form').hidden);
  await profileScenario.page.screenshot({ path: path.join(screenshotDir, 'task-17-reading-profile.png'), fullPage: true });
  await profileScenario.page.check('#profile-unknown-time');
  await profileScenario.page.uncheck('#profile-unknown-time');
  await profileScenario.page.click('#profile-save');
  assert.equal(await profileScenario.page.locator('#profile-error').textContent(), '请选择出生时间。', 'profile form requires a birth time when unknown time is not selected');
  assert.equal(await profileScenario.page.evaluate(() => window.__hakuTest.profilePuts), 0, 'missing profile time does not send a request');
  await profileScenario.page.click('#profile-time');
  await profileScenario.page.locator('#time-hour-23').click();
  await profileScenario.page.locator('#time-minute-30').click();
  await profileScenario.page.click('#wheel-confirm');
  await profileScenario.page.evaluate(() => { window.__hakuTest.profileFails = true; });
  await profileScenario.page.click('#profile-save');
  await profileScenario.page.waitForFunction(() => window.__hakuTest.profilePuts === 1);
  assert.equal(await profileScenario.page.locator('#profile-error').textContent(), '保存失败，请重试。', 'profile form save failures stay inline with form-specific copy');
  assert.doesNotMatch(await profileScenario.page.locator('#profile-error').textContent(), /不会影响本次阅读/, 'profile form does not use questionnaire failure copy');
  await profileScenario.page.evaluate(() => { window.__hakuTest.profileFails = false; });
  await profileScenario.page.click('#profile-save');
  await profileScenario.page.waitForFunction(() => window.__hakuTest.profilePuts === 2 && JSON.parse(localStorage.getItem('__hakuFakeProfile')).birth_time === '23:30');
  await profileScenario.page.click('#me-back');
  await profileScenario.page.waitForFunction(() => !document.querySelector('#mini-view').hidden);
  await profileScenario.page.click('#start-reading');
  await profileScenario.page.click('#question-next');
  assert.equal(await profileScenario.page.locator('#answer-time').textContent(), '23:30', 'My account edit prefills the questionnaire with 23:30');
  await profileScenario.page.click('#question-prev');
  await profileScenario.page.click('#question-prev');
  await profileScenario.page.click('#user-entry');
  await profileScenario.page.click('#profile-delete');
  await profileScenario.page.click('#delete-confirm');
  await profileScenario.page.waitForFunction(() => window.__hakuTest.profileDeletes === 1);
  assert.ok(await profileScenario.page.evaluate(() => localStorage.getItem('__hakuFakeAccount')), 'profile deletion keeps the account');
  await profileScenario.page.click('#me-back');
  await profileScenario.page.waitForFunction(() => !document.querySelector('#mini-view').hidden);
  await profileScenario.page.click('#start-reading');
  assert.match(await profileScenario.page.locator('#answer-date').textContent(), /选择出生日期/, 'profile deletion restores an empty questionnaire');
  assert.deepEqual(profileScenario.errors, []);
  await profileScenario.context.close();

  const ziweiScenario = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  assert.equal(await ziweiScenario.page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('iztro-2.6.3.min.js'))), false, 'home does not request iztro');
  await completeReading(ziweiScenario.page, { gender: 'male' });
  await ziweiScenario.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && window.iztro?.astro);
  await ziweiScenario.page.click('#manga-next');
  await ziweiScenario.page.waitForFunction(() => document.querySelector('#comic-subline').textContent.includes('命宫'));
  assert.match(await ziweiScenario.page.locator('#comic-subline').textContent(), /命宫/, 'story includes a Life Palace theme');
  await ziweiScenario.page.click('#manga-next');
  await ziweiScenario.page.click('#manga-next');
  assert.match(await ziweiScenario.page.locator('#comic-subline').textContent(), /夫妻宫/, 'relationship page includes a Relationship Palace theme');
  await ziweiScenario.page.click('#manga-next');
  await ziweiScenario.page.click('#manga-next');
  await ziweiScenario.page.locator('#story-ziwei').scrollIntoViewIfNeeded();
  assert.equal(await ziweiScenario.page.locator('#story-ziwei').isVisible(), true, 'final story page offers the Zi Wei chart');
  await ziweiScenario.page.screenshot({ path: path.join(screenshotDir, 'task-18-story-ziwei-entry.png') });
  await ziweiScenario.page.click('#story-ziwei');
  await ziweiScenario.page.waitForFunction(() => !document.querySelector('#ziwei-content').hidden);
  assert.equal(await ziweiScenario.page.locator('#ziwei-board .ziwei-palace').count(), 12, 'Zi Wei chart renders all twelve palaces');
  assert.equal(await ziweiScenario.page.locator('.ziwei-center').count(), 1, 'Zi Wei chart has one central summary');
  assert.equal(await ziweiScenario.page.locator('.ziwei-palace.is-current').count(), 1, 'disclosed gender highlights exactly one current decade cycle');
  assert.equal(await ziweiScenario.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'Zi Wei chart has no horizontal overflow at 390px');
  await ziweiScenario.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-chart-390.png'), fullPage: true });
  await ziweiScenario.page.evaluate(() => window.__hakuTest.back.click());
  await ziweiScenario.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && document.querySelector('#ziwei-view').hidden);
  assert.deepEqual(ziweiScenario.errors, []);
  await ziweiScenario.context.close();

  const unknownZiwei = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  await completeReading(unknownZiwei.page, { gender: 'male', unknownTime: true });
  await unknownZiwei.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden);
  await unknownZiwei.page.locator('[data-page="5"]').click();
  await unknownZiwei.page.click('#story-ziwei');
  await unknownZiwei.page.waitForFunction(() => !document.querySelector('#ziwei-view').hidden);
  assert.equal(await unknownZiwei.page.locator('#ziwei-board .ziwei-palace').count(), 0, 'unknown birth time does not render a chart');
  assert.match(await unknownZiwei.page.locator('#ziwei-status').textContent(), /需要出生时间/);
  assert.deepEqual(unknownZiwei.errors, []);
  await unknownZiwei.context.close();

  const undisclosedZiwei = await openScenario({ locale: 'vi', state: 'saved', viewport: { width: 390, height: 750 }, colorScheme: 'dark' });
  await completeReading(undisclosedZiwei.page, { gender: 'undisclosed' });
  await undisclosedZiwei.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && window.iztro?.astro);
  await undisclosedZiwei.page.locator('[data-page="5"]').click();
  await undisclosedZiwei.page.click('#story-ziwei');
  await undisclosedZiwei.page.waitForFunction(() => !document.querySelector('#ziwei-content').hidden);
  assert.equal(await undisclosedZiwei.page.locator('.ziwei-decadal').count(), 0, 'undisclosed gender hides decade cycles');
  assert.equal(await undisclosedZiwei.page.locator('.ziwei-palace.is-current').count(), 0, 'undisclosed gender does not highlight a decade cycle');
  assert.match(await undisclosedZiwei.page.locator('#ziwei-footnote').textContent(), /Đại hạn được ẩn/);
  assert.equal(await undisclosedZiwei.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'dark Zi Wei chart has no horizontal overflow');
  await undisclosedZiwei.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-undisclosed-dark.png'), fullPage: true });
  assert.deepEqual(undisclosedZiwei.errors, []);
  await undisclosedZiwei.context.close();

  const oldConsent = await openScenario({ locale: 'zh', state: 'old-v4', viewport: { width: 390, height: 750 } });
  assert.equal(await oldConsent.page.locator('#consent-panel').isVisible(), true, 'v4 user sees renewed consent on home');
  assert.equal(await oldConsent.page.locator('#consent').isChecked(), true, 'renewed consent is selected by default');
  await oldConsent.page.screenshot({ path: path.join(screenshotDir, 'task-17-renew-consent.png') });
  await oldConsent.page.click('#user-entry');
  await oldConsent.page.waitForFunction(() => !document.querySelector('#me-view').hidden);
  assert.equal(await oldConsent.page.locator('#me-consent-panel').isVisible(), true, 'v4 user sees renewed consent in My account');
  assert.equal(await oldConsent.page.locator('#me-consent').isChecked(), true, 'My account renewed consent is selected by default');
  await oldConsent.page.click('#me-back');
  await oldConsent.page.waitForFunction(() => !document.querySelector('#mini-view').hidden);
  await oldConsent.page.uncheck('#consent');
  await oldConsent.page.click('#start-reading');
  assert.equal(await oldConsent.page.evaluate(() => window.__hakuTest.consentCalls), 0, 'clearing renewed consent does not submit consent');
  assert.equal(await oldConsent.page.evaluate(() => window.__hakuTest.profilePuts), 0, 'v4 user without renewed consent does not save a profile');
  assert.deepEqual(oldConsent.errors, []);
  await oldConsent.context.close();

  console.log('check-first-screen.mjs: layout, Telegram controls, shared wheels, reading profiles, lazy Zi Wei, chart routing, and screenshots pass.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
