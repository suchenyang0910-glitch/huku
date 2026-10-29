import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const screenshotDir = process.env.HAKU_SCREENSHOT_DIR ? path.resolve(process.env.HAKU_SCREENSHOT_DIR) : path.join(root, 'docs', 'screenshots');
const baselineHtml = execFileSync('git', ['show', '01d8211:haku.html'], { encoding: 'utf8' });
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://mini.localhost').pathname;
    const relative = pathname === '/' ? 'haku.html' : pathname.startsWith('/assets/') ? `public${pathname}` : pathname.slice(1);
    if (relative !== 'haku.html' && relative !== 'baseline.html' && !relative.startsWith('public/assets/')) throw new Error('not found');
    if (relative === 'baseline.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(baselineHtml);
      return;
    }
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

async function openScenario({ locale = 'en', state = 'verified-unsaved', viewport = viewports[0], consentFails = false, profileFails = false, telegram = true, colorScheme = 'light', storyMode = 'ok', deviceScaleFactor = 1, source = 'haku.html' } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const storyRequests = [];
  await context.route('**/assets/story/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    storyRequests.push(pathname);
    const fail = storyMode === 'fail' || (storyMode === 'fallback' && !pathname.includes('/fallback-'));
    return fail ? route.abort('failed') : route.continue();
  });
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
      if (state === 'saved' || state === 'old-v5') localStorage.setItem('__hakuFakeAccount', JSON.stringify({ telegram_id: '42', locale, consent_version: state === 'old-v5' ? '2026-10-28-v5-ziwei-gender' : '2026-10-28-v6-reading-themes' }));
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
        return new Response(saved ? JSON.stringify({ ...saved, consent_current: saved.consent_version === '2026-10-28-v6-reading-themes', profile: profile ? JSON.parse(profile) : null }) : '{}', { status: saved ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/telegram/consent')) {
        window.__hakuTest.consentCalls++;
        if (!consentFails) localStorage.setItem('__hakuFakeAccount', JSON.stringify({ telegram_id: '42', locale, consent_version: '2026-10-28-v6-reading-themes' }));
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
  await page.goto(`http://mini.localhost:${port}/${source}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(telegram => window.__hakuTest && window.__hakuTest.authCalls === (telegram ? 1 : 0), telegram);
  await page.waitForTimeout(20);
  return { context, page, errors, storyRequests };
}

async function chooseTheme(page, theme = 'love') {
  await page.locator(`[name="answer-theme"][value="${theme}"]`).check();
  await page.click('#question-next');
}

async function completeReading(page, { gender = 'male', unknownTime = false, theme = 'love', state = 0, concern = 0, duration = 0, hour = 12, minute = 0 } = {}) {
  await page.click('#start-reading');
  await chooseTheme(page, theme);
  await page.click('#answer-date');
  await page.locator('#date-month-5').click();
  await page.locator('#date-day-15').click();
  await page.click('#wheel-confirm');
  await page.selectOption('#answer-place', 'cn');
  await page.click('#question-next');
  if (unknownTime) await page.check('#unknown-time');
  else {
    await page.click('#answer-time');
    await page.locator(`#time-hour-${hour}`).click();
    await page.locator(`#time-minute-${minute}`).click();
    await page.click('#wheel-confirm');
  }
  await page.click('#question-next');
  await page.locator(`[name="answer-gender"][value="${gender}"]`).check();
  await page.click('#question-next');
  for (const [name, value] of [['relationship', state], ['concern', concern], ['duration', duration]]) {
    await page.locator(`[name="answer-${name}"][value="${value}"]`).check();
    await page.click('#question-next');
  }
  await page.waitForFunction(() => window.__hakuTest.profilePuts === 1);
}

async function storyPages(page, onPage) {
  await page.waitForFunction(() => document.querySelectorAll('#reader-dots [data-page]').length === 6);
  const pages = [];
  for (let index = 0; index < 6; index++) {
    await page.waitForFunction(expected => document.querySelector('#reader-progress').textContent === `${expected + 1} / 6`, index);
    pages.push(await page.evaluate(() => ({
      title: document.querySelector('#comic-line').textContent,
      body: document.querySelector('#comic-subline').innerText,
      style: {
        subline: getComputedStyle(document.querySelector('#comic-subline')).font,
        copy: getComputedStyle(document.querySelector('#comic-subline .story-copy') || document.querySelector('#comic-subline')).font,
        note: document.querySelector('#comic-subline .pillar-note') ? getComputedStyle(document.querySelector('#comic-subline .pillar-note')).font : null
      }
    })));
    await onPage?.(index, page);
    if (index < 5) await page.locator(`#reader-dots [data-page="${index + 1}"]`).click();
  }
  return pages;
}

try {
  if (process.argv.includes('--task21-only')) {
    await mkdir(screenshotDir, { recursive: true });
    const zh = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
    await completeReading(zh.page, { theme: 'love', state: 2, concern: 1, duration: 3, hour: 13, minute: 30 });
    const zhProfile = await zh.page.evaluate(() => JSON.parse(localStorage.getItem('__hakuFakeProfile')));
    assert.equal(zhProfile.birth_date, '1990-05-15', 'task 21 Chinese screenshots use the requested date');
    assert.equal(zhProfile.birth_time, '13:30', 'task 21 Chinese screenshots use the requested time');
    assert.equal(zhProfile.place, 'cn', 'task 21 Chinese screenshots use China as the birthplace');
    await zh.page.waitForFunction(() => document.querySelectorAll('#reader-dots [data-page]').length === 6);
    for (let page = 0; page < 6; page++) {
      await zh.page.waitForFunction(expected => document.querySelector('#reader-progress').textContent === `${expected + 1} / 6`, page);
      if (page === 0) {
        await zh.page.locator('.story-details summary').click();
        await zh.page.screenshot({ path: path.join(screenshotDir, 'task-21-zh-details-open.png'), fullPage: true });
        await zh.page.locator('.story-details summary').click();
      }
      if (page === 5) await zh.page.screenshot({ path: path.join(screenshotDir, 'task-21-zh-keepsake-light.png'), fullPage: true });
      if (page === 4) {
        const size = await zh.page.evaluate(() => ({ story: parseFloat(getComputedStyle(document.querySelector('#comic-subline .story-copy')).fontSize), main: parseFloat(getComputedStyle(document.querySelector('#comic-subline')).fontSize) }));
        assert.ok(size.story >= size.main, 'Chinese page 5 copy is at least as large as the main story text');
      }
      await zh.page.screenshot({ path: path.join(screenshotDir, `task-21-zh-light-p${page + 1}.png`), fullPage: true });
      if (page < 5) await zh.page.locator(`#reader-dots [data-page="${page + 1}"]`).click();
    }
    assert.deepEqual(zh.errors, []);
    await zh.context.close();
    const en = await openScenario({ locale: 'en', state: 'saved', viewport: { width: 390, height: 750 }, colorScheme: 'dark' });
    await completeReading(en.page, { theme: 'love', state: 2, concern: 1, duration: 3, hour: 13, minute: 30 });
    const enProfile = await en.page.evaluate(() => JSON.parse(localStorage.getItem('__hakuFakeProfile')));
    assert.equal(enProfile.birth_date, '1990-05-15');
    assert.equal(enProfile.birth_time, '13:30');
    assert.equal(enProfile.place, 'cn');
    await en.page.waitForFunction(() => document.querySelectorAll('#reader-dots [data-page]').length === 6);
    await en.page.screenshot({ path: path.join(screenshotDir, 'task-21-en-dark-p1.png'), fullPage: true });
    await en.page.locator('#reader-dots [data-page="1"]').click();
    await en.page.waitForFunction(() => document.querySelector('#reader-progress').textContent === '2 / 6');
    const p2 = await en.page.locator('#comic-subline').innerText();
    assert.equal(p2.split('\n').filter(line => line.includes('Your Life Palace')).length, 1, 'English page 2 includes the Zi Wei line once');
    await en.page.screenshot({ path: path.join(screenshotDir, 'task-21-en-dark-p2.png'), fullPage: true });
    for (let page = 2; page <= 5; page++) {
      await en.page.locator(`#reader-dots [data-page="${page}"]`).click();
      await en.page.waitForFunction(expected => document.querySelector('#reader-progress').textContent === `${expected + 1} / 6`, page);
      if (page === 2) {
        const p3 = await en.page.locator('#comic-subline').innerText();
        assert.match(p3, /Fire and Metal.*equally/i, 'English page 3 uses tied-element narrative');
      }
      if (page + 1 === 6) await en.page.screenshot({ path: path.join(screenshotDir, 'task-21-en-keepsake-dark.png'), fullPage: true });
      if (page + 1 === 5) {
        const size = await en.page.evaluate(() => ({ story: parseFloat(getComputedStyle(document.querySelector('#comic-subline .story-copy')).fontSize), main: parseFloat(getComputedStyle(document.querySelector('#comic-subline')).fontSize) }));
        assert.ok(size.story >= size.main, 'English page 5 copy is at least as large as the main story text');
      }
      await en.page.screenshot({ path: path.join(screenshotDir, `task-21-en-dark-p${page + 1}.png`), fullPage: true });
    }
    assert.deepEqual(en.errors, []);
    await en.context.close();

    for (const locale of ['vi','th','km']) {
      const baseline = await openScenario({ locale, state: 'saved', viewport: { width: 390, height: 750 }, source: 'baseline.html' });
      await completeReading(baseline.page, { theme: 'love', state: 2, concern: 1, duration: 3, hour: 13, minute: 30 });
      const expected = await storyPages(baseline.page);
      const legacy = await openScenario({ locale, state: 'saved', viewport: { width: 390, height: 750 } });
      await completeReading(legacy.page, { theme: 'love', state: 2, concern: 1, duration: 3, hour: 13, minute: 30 });
      const actual = await storyPages(legacy.page, async (index, page) => {
        if (locale === 'vi' && index === 4) {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'Vietnamese legacy page 5 has no horizontal overflow at 390px');
          await page.screenshot({ path: path.join(screenshotDir, 'task-21-vi-legacy-p5.png'), fullPage: true });
        }
      });
      assert.deepEqual(actual, expected, `${locale} six-page title, body, and typography match main 01d8211`);
      assert.deepEqual(baseline.errors, []);
      assert.deepEqual(legacy.errors, []);
      await baseline.context.close();
      await legacy.context.close();
    }
  } else {
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
  await chooseTheme(dateScenario.page);
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
  await chooseTheme(darkScenario.page);
  await darkScenario.page.click('#answer-date');
  assert.equal(await darkScenario.page.evaluate(() => document.documentElement.classList.contains('telegram-dark')), true, 'date wheel follows Telegram dark mode');
  assert.equal(await darkScenario.page.locator('.wheel-picker-sheet').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(41, 58, 51)', 'date wheel uses the raised dark surface');
  assert.deepEqual(darkScenario.errors, []);
  await darkScenario.context.close();

  const timeScenario = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  await timeScenario.page.click('#start-reading');
  await chooseTheme(timeScenario.page);
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
  assert.equal(await timeScenario.page.locator('#step-label').textContent(), '04', 'confirmed time can continue to the next question');
  assert.equal(await timeScenario.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'time question does not scroll horizontally');
  assert.deepEqual(timeScenario.errors, []);
  await timeScenario.context.close();

  const profileScenario = await openScenario({ locale: 'zh', state: 'verified-unsaved', viewport: { width: 390, height: 750 } });
  await completeReading(profileScenario.page, { theme: 'career' });
  assert.equal(await profileScenario.page.evaluate(() => JSON.parse(localStorage.getItem('__hakuFakeProfile')).birth_date), '1990-05-15', 'completed questionnaire saves the profile');
  assert.equal(await profileScenario.page.evaluate(() => JSON.parse(localStorage.getItem('__hakuFakeProfile')).theme), 'career', 'completed questionnaire saves the selected theme');
  await profileScenario.page.reload({ waitUntil: 'domcontentloaded' });
  await profileScenario.page.waitForFunction(() => window.__hakuTest.authCalls === 1 && !document.querySelector('#start-reading').disabled);
  await profileScenario.page.click('#start-reading');
  assert.equal(await profileScenario.page.locator('[name="answer-theme"][value="career"]').isChecked(), true, 'refresh prefills the saved theme');
  await profileScenario.page.click('#question-next');
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
  await chooseTheme(profileScenario.page);
  assert.match(await profileScenario.page.locator('#answer-date').textContent(), /选择出生日期/, 'profile deletion restores an empty questionnaire');
  assert.deepEqual(profileScenario.errors, []);
  await profileScenario.context.close();

  const illustrated = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 }, deviceScaleFactor: 2 });
  assert.deepEqual(illustrated.storyRequests, [], 'home does not request story illustrations');
  await completeReading(illustrated.page);
  await illustrated.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && document.querySelector('#story-illustration').classList.contains('is-loaded'));
  const illustrationIds = [];
  const illustrationSources = [];
  for (let index = 0; index < 6; index++) {
    if (index) await illustrated.page.locator(`[data-page="${index}"]`).click();
    await illustrated.page.waitForFunction(expected => document.querySelector('#story-illustration').classList.contains('is-loaded') && document.querySelector('#story-illustration').dataset.scene.startsWith(expected), `p${index + 1}-`);
    illustrationIds.push(await illustrated.page.locator('#story-illustration').getAttribute('data-scene'));
    illustrationSources.push(await illustrated.page.locator('#story-illustration').evaluate(image => image.currentSrc));
    await illustrated.page.waitForTimeout(400);
    await illustrated.page.screenshot({ path: path.join(screenshotDir, `task-19-story-page-${index + 1}-390.png`), fullPage: true });
  }
  assert.equal(new Set(illustrationIds).size, 6, 'all six story pages resolve distinct scene illustrations');
  assert.equal(new Set(illustrationSources).size, 6, 'all six story pages load distinct published image files');
  assert.equal(illustrationIds[0], 'p1-opening-a');
  assert.match(illustrationIds[1], /^p2-daymaster-(wood|fire|earth|metal|water)$/);
  assert.equal(illustrationIds[2], 'p3-balanced', 'a tied strongest element uses the balanced scene');
  assert.equal(illustrationIds[3], 'p4-love-hoping');
  assert.equal(illustrationIds[4], 'p5-love-clarity');
  assert.match(illustrationIds[5], /^p6-action-(wood|fire|earth|metal|water)$/);
  assert.ok(illustrated.storyRequests.some(pathname => pathname.endsWith('-1080.webp')), '390px DPR preloads responsive 1080px story artwork');
  assert.equal(await illustrated.page.locator('#story-illustration').evaluate(image => { const rect=image.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===image }), true, 'loaded artwork paints above the code-drawn fallback');
  await illustrated.page.waitForTimeout(400);
  assert.equal(await illustrated.page.locator('#story-illustration').evaluate(image => getComputedStyle(image).opacity), '1', 'story artwork finishes its fade-in');
  const artRatio = await illustrated.page.locator('.scene-art').evaluate(element => { const box=element.getBoundingClientRect();return { ratio:box.width/box.height,height:box.height } });
  assert.ok(artRatio.ratio >= .95 && artRatio.ratio <= 1.05, `390px story art is square (ratio ${artRatio.ratio})`);
  assert.ok(artRatio.height <= 360, '390px story art stays within the 360px height cap');
  assert.equal(await illustrated.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'illustrated story has no horizontal overflow at 390px');
  await illustrated.page.screenshot({ path: path.join(screenshotDir, 'task-19-story-light-390.png'), fullPage: true });
  assert.deepEqual(illustrated.errors, []);
  await illustrated.context.close();

  const themePicker = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 } });
  await themePicker.page.click('#start-reading');
  assert.equal(await themePicker.page.locator('[name="answer-theme"]').count(), 4, 'theme step offers four choices');
  assert.equal(await themePicker.page.locator('#step-total').textContent(), '/ 07', 'questionnaire shows seven steps');
  await themePicker.page.screenshot({ path: path.join(screenshotDir, 'task-20-theme-picker-390.png'), fullPage: true });
  assert.deepEqual(themePicker.errors, []);
  await themePicker.context.close();

  const themeSceneKeys = {
    love: ['hoping', 'clarity'], wealth: ['steady', 'not-enough'],
    career: ['searching', 'unseen'], social: ['new-friends', 'speak-up']
  };
  for (const locale of locales) for (const [theme, [stateKey, concernKey]] of Object.entries(themeSceneKeys)) {
    const scenario = await openScenario({ locale, state: 'saved', viewport: { width: 390, height: 750 } });
    await completeReading(scenario.page, { theme });
    await scenario.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden);
    await scenario.page.locator('[data-page="3"]').click();
    await scenario.page.waitForFunction(expected => {
      const image = document.querySelector('#story-illustration');
      return image.classList.contains('is-loaded') && image.dataset.scene === expected && image.dataset.asset === expected && getComputedStyle(image).opacity === '1';
    }, `p4-${theme}-${stateKey}`);
    assert.equal(await scenario.page.locator('#story-illustration').getAttribute('data-scene'), `p4-${theme}-${stateKey}`, `${locale}/${theme} selects its state illustration`);
    if (locale === 'zh') await scenario.page.screenshot({ path: path.join(screenshotDir, `task-20-${theme}-page-4-390.png`), fullPage: true });
    await scenario.page.locator('[data-page="4"]').click();
    await scenario.page.waitForFunction(expected => document.querySelector('#story-illustration').dataset.scene === expected, `p5-${theme}-${concernKey}`);
    assert.equal(await scenario.page.locator('#story-illustration').getAttribute('data-scene'), `p5-${theme}-${concernKey}`, `${locale}/${theme} selects its concern illustration`);
    assert.equal(await scenario.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${locale}/${theme} has no horizontal overflow`);
    assert.deepEqual(scenario.errors, []);
    await scenario.context.close();
  }

  const changedTheme = await openScenario({ locale: 'en', state: 'saved', viewport: { width: 390, height: 750 } });
  await changedTheme.page.click('#start-reading');
  await chooseTheme(changedTheme.page, 'love');
  await changedTheme.page.click('#answer-date');
  await changedTheme.page.click('#wheel-confirm');
  await changedTheme.page.click('#question-next');
  await changedTheme.page.click('#answer-time');
  await changedTheme.page.click('#wheel-confirm');
  await changedTheme.page.click('#question-next');
  await changedTheme.page.locator('[name="answer-gender"][value="male"]').check();
  await changedTheme.page.click('#question-next');
  await changedTheme.page.locator('[name="answer-relationship"][value="1"]').check();
  await changedTheme.page.click('#question-next');
  await changedTheme.page.locator('[name="answer-concern"][value="2"]').check();
  for (let index = 0; index < 5; index++) await changedTheme.page.click('#question-prev');
  await changedTheme.page.locator('[name="answer-theme"][value="wealth"]').check();
  await changedTheme.page.click('#question-next');
  await changedTheme.page.click('#question-next');
  await changedTheme.page.click('#question-next');
  await changedTheme.page.click('#question-next');
  assert.equal(await changedTheme.page.locator('[name="answer-relationship"]:checked').count(), 0, 'changing theme clears the previous state');
  await changedTheme.page.locator('[name="answer-relationship"]').first().check();
  await changedTheme.page.click('#question-next');
  assert.equal(await changedTheme.page.locator('[name="answer-concern"]:checked').count(), 0, 'changing theme clears the previous concern');
  assert.deepEqual(changedTheme.errors, []);
  await changedTheme.context.close();

  const fallbackStory = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 }, storyMode: 'fallback' });
  await completeReading(fallbackStory.page);
  await fallbackStory.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && document.querySelector('#story-illustration').classList.contains('is-loaded') && document.querySelector('#story-illustration').dataset.asset === 'fallback');
  assert.match(fallbackStory.storyRequests[0], /p1-opening-a-(?:640|1080)\.webp$/);
  assert.match(fallbackStory.storyRequests[1], /fallback-(?:640|1080)\.webp$/, 'failed scene loads the published fallback next');
  assert.deepEqual(fallbackStory.errors, []);
  await fallbackStory.context.close();

  const codeFallback = await openScenario({ locale: 'zh', state: 'saved', viewport: { width: 390, height: 750 }, storyMode: 'fail' });
  await completeReading(codeFallback.page);
  await codeFallback.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && document.querySelector('#story-illustration').dataset.scene === 'p1-opening-a');
  await codeFallback.page.waitForTimeout(80);
  assert.equal(await codeFallback.page.locator('#story-illustration').evaluate(image => image.classList.contains('is-loaded')), false, 'failed scene and fallback stay transparent');
  assert.equal(await codeFallback.page.locator('.scene-moon').isVisible(), true, 'failed fallback keeps the code-drawn scene visible');
  assert.deepEqual(codeFallback.errors, []);
  await codeFallback.context.close();

  const darkIllustrated = await openScenario({ locale: 'vi', state: 'saved', viewport: { width: 390, height: 750 }, colorScheme: 'dark' });
  await completeReading(darkIllustrated.page, { gender: 'undisclosed' });
  await darkIllustrated.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && document.querySelector('#story-illustration').classList.contains('is-loaded'));
  await darkIllustrated.page.locator('[data-page="3"]').click();
  await darkIllustrated.page.waitForFunction(() => document.querySelector('#story-illustration').dataset.scene.startsWith('p4-') && document.querySelector('#story-illustration').classList.contains('is-loaded'));
  await darkIllustrated.page.waitForTimeout(400);
  const viStoryFonts = await darkIllustrated.page.evaluate(() => ({ title:getComputedStyle(document.querySelector('.reader-head h2')).fontFamily,body:getComputedStyle(document.querySelector('#comic-line')).fontFamily }));
  assert.doesNotMatch(`${viStoryFonts.title} ${viStoryFonts.body}`, /Georgia/i, 'Vietnamese story title and body never use Georgia');
  assert.match(`${viStoryFonts.title} ${viStoryFonts.body}`, /Be Vietnam Pro|Arial|sans-serif/i, 'Vietnamese story uses a Vietnamese-safe sans-serif stack');
  assert.deepEqual(await darkIllustrated.page.locator('.comic-caption').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color })), { background: 'rgb(255, 253, 248)', color: 'rgb(36, 51, 49)' }, 'dark theme keeps the story caption on readable warm paper');
  assert.equal(await darkIllustrated.page.evaluate(() => { const art=document.querySelector('.scene-art').getBoundingClientRect(),caption=document.querySelector('.comic-caption').getBoundingClientRect();return Math.round(art.bottom) <= Math.round(caption.top) && art.height >= 260 }), true, 'long localized copy follows the illustration without covering it');
  await darkIllustrated.page.screenshot({ path: path.join(screenshotDir, 'task-19-story-dark-390.png'), fullPage: true });
  assert.equal(await darkIllustrated.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'dark illustrated story has no horizontal overflow at 390px');
  assert.deepEqual(darkIllustrated.errors, []);
  await darkIllustrated.context.close();

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
  assert.equal(await ziweiScenario.page.locator('#ziwei-list').isVisible(), true, '390px defaults to the readable list view');
  const minimumZiweiFont = await ziweiScenario.page.evaluate(() => Math.min(...[...document.querySelectorAll('#ziwei-content *')].filter((node) => {
    const style = getComputedStyle(node);
    return node.textContent.trim() && style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length;
  }).map((node) => parseFloat(getComputedStyle(node).fontSize))));
  assert.ok(minimumZiweiFont >= 11, `all visible Zi Wei text at 390px is at least 11px (found ${minimumZiweiFont}px)`);
  assert.ok(await ziweiScenario.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'Zi Wei chart has no page-level horizontal overflow at 390px');
  await ziweiScenario.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-chart-390.png'), fullPage: true });
  await ziweiScenario.page.locator('#ziwei-list [data-ziwei-palace]').first().click();
  assert.equal(await ziweiScenario.page.locator('#ziwei-detail').isVisible(), true, 'a list palace opens its complete details');
  assert.match(await ziweiScenario.page.locator('#ziwei-detail').textContent(), /大限/, 'palace details include the decade range');
  assert.ok(await ziweiScenario.page.locator('#ziwei-detail *').evaluateAll((nodes) => Math.min(...nodes.filter((node) => node.textContent.trim() && node.getClientRects().length).map((node) => parseFloat(getComputedStyle(node).fontSize)))) >= 11, 'expanded palace details keep every visible label at least 11px');
  await ziweiScenario.page.click('[data-ziwei-mode="grid"]');
  assert.equal(await ziweiScenario.page.locator('#ziwei-board-scroll').isVisible(), true, 'grid remains available on narrow screens');
  assert.equal(await ziweiScenario.page.evaluate(() => document.querySelector('#ziwei-board-scroll').scrollWidth > document.querySelector('#ziwei-board-scroll').clientWidth), true, 'the narrow grid scrolls inside its chart container');
  const minimumGridFont = await ziweiScenario.page.evaluate(() => Math.min(...[...document.querySelectorAll('#ziwei-content *')].filter((node) => {
    const style = getComputedStyle(node);
    return node.textContent.trim() && style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length;
  }).map((node) => parseFloat(getComputedStyle(node).fontSize))));
  assert.ok(minimumGridFont >= 11, `all visible grid text at 390px is at least 11px (found ${minimumGridFont}px)`);
  assert.ok(await ziweiScenario.page.locator('#ziwei-board .ziwei-palace strong').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize)) >= 12, 'palace names remain at least 12px');
  assert.ok(await ziweiScenario.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'the scrollable grid does not widen the page');
  await ziweiScenario.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-grid-390.png'), fullPage: true });
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

  for (const locale of ['en', 'vi', 'km', 'th']) {
    const localized = await openScenario({ locale, state: 'saved', viewport: { width: 390, height: 750 } });
    await completeReading(localized.page, { gender: 'male' });
    await localized.page.waitForFunction(() => !document.querySelector('#manga-screen').hidden && window.iztro?.astro);
    await localized.page.click('#manga-next');
    await localized.page.waitForFunction(() => document.querySelector('#comic-subline').textContent.trim().length > 0);
    const storyText = await localized.page.locator('#comic-subline .story-copy').last().textContent();
    await localized.page.locator('[data-page="5"]').click();
    await localized.page.click('#story-ziwei');
    await localized.page.waitForFunction(() => !document.querySelector('#ziwei-content').hidden);
    const chartText = await localized.page.locator('#ziwei-content').textContent();
    if (['km', 'th'].includes(locale)) {
      const palaceLabels = await localized.page.locator('#ziwei-list strong').allTextContents();
      assert.equal(palaceLabels.filter((label) => /\([^)]*[\u3400-\u9fff]+\)/.test(label)).length, 12, `${locale} shows all twelve local palace names with parenthesized Chinese originals`);
    }
    const visibleChinese = `${storyText} ${chartText}`.replace(/\([^)]*[\u3400-\u9fff][^)]*\)/g, '');
    assert.doesNotMatch(visibleChinese, /[\u3400-\u9fff]/, `${locale} story and chart do not leak untranslated Chinese outside parenthesized originals`);
    if (locale === 'en') {
      assert.match(storyText, /^Your Life Palace centers on Tian Liang \(Protector\):/, 'English story uses the Haku star name in a natural sentence');
      assert.equal(await localized.page.locator('#ziwei-list strong').first().textContent(), 'Life', 'accessible palace list begins with the Life Palace');
      assert.match(chartText, /Ding Hai/, 'English stems and branches use pinyin');
      assert.match(chartText, /Tian Liang \(Protector\)/, 'English chart uses Haku pinyin star names');
      assert.match(chartText, /Earth fifth class/, 'English chart uses Haku five-elements class names');
      assert.match(chartText, /(?:Brilliant|Strong|Gained|Favorable|Neutral|Weak|Fallen)/, 'English chart uses word-based brightness labels');
      assert.match(chartText, /Lu \(Prosperity\)|Quan \(Power\)|Ke \(Recognition\)|Ji \(Challenge\)/, 'English chart uses named annual transformations');
      assert.doesNotMatch(chartText, /\[[+-]\d\]|\bwoo\b/, 'English chart does not expose iztro symbolic brightness or romanization');
      await localized.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-en-list-390.png'), fullPage: true });
      await localized.page.click('[data-ziwei-mode="grid"]');
      await localized.page.screenshot({ path: path.join(screenshotDir, 'task-18-ziwei-en-grid-390.png'), fullPage: true });
    }
    assert.deepEqual(localized.errors, []);
    await localized.context.close();
  }

  const oldConsent = await openScenario({ locale: 'zh', state: 'old-v5', viewport: { width: 390, height: 750 } });
  assert.equal(await oldConsent.page.locator('#consent-panel').isVisible(), true, 'v5 user sees renewed consent on home');
  assert.equal(await oldConsent.page.locator('#consent').isChecked(), true, 'renewed consent is selected by default');
  await oldConsent.page.screenshot({ path: path.join(screenshotDir, 'task-17-renew-consent.png') });
  await oldConsent.page.click('#user-entry');
  await oldConsent.page.waitForFunction(() => !document.querySelector('#me-view').hidden);
  assert.equal(await oldConsent.page.locator('#me-consent-panel').isVisible(), true, 'v5 user sees renewed consent in My account');
  assert.equal(await oldConsent.page.locator('#me-consent').isChecked(), true, 'My account renewed consent is selected by default');
  await oldConsent.page.click('#me-back');
  await oldConsent.page.waitForFunction(() => !document.querySelector('#mini-view').hidden);
  await oldConsent.page.uncheck('#consent');
  await oldConsent.page.click('#start-reading');
  assert.equal(await oldConsent.page.evaluate(() => window.__hakuTest.consentCalls), 0, 'clearing renewed consent does not submit consent');
  assert.equal(await oldConsent.page.evaluate(() => window.__hakuTest.profilePuts), 0, 'v5 user without renewed consent does not save a profile');
  assert.deepEqual(oldConsent.errors, []);
  await oldConsent.context.close();

  console.log('check-first-screen.mjs: layout, Telegram controls, shared wheels, four localized reading themes, profiles, story art, Zi Wei, routing, and screenshots pass.');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
