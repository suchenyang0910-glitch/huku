import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(ROOT, 'haku.html'), 'utf8');
let source = html.slice(html.indexOf('const T ='), html.indexOf('const $='));
source = source.replace('const T =', 'globalThis.T =').replace('const F=', 'globalThis.F=').replace('const A=', 'globalThis.A=');
const copy = {};
vm.runInNewContext(source, copy);

function compareShape(expected, actual, path) {
  assert.equal(Array.isArray(actual), Array.isArray(expected), `${path} has the same container type`);
  if (!expected || typeof expected !== 'object') return;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} has exactly the English keys`);
  for (const key of Object.keys(expected)) compareShape(expected[key], actual[key], `${path}.${key}`);
}

for (const locale of ['vi', 'zh', 'km', 'th']) {
  for (const name of ['T', 'F', 'A']) compareShape(copy[name].en, copy[name][locale], `${name}.${locale}`);
}
assert.match(html, /data-language="en">English<\/button><button[^>]+data-language="vi">Tiếng Việt<\/button><button[^>]+data-language="zh">简体中文<\/button><button[^>]+data-language="km">ខ្មែរ<\/button><button[^>]+data-language="th">ไทย<\/button>/, 'language menu order is en, vi, zh, km, th');
assert.match(html, /tgLanguage\.startsWith\('vi'\)\?'vi'/, 'Telegram vi and vi-* languages default to Vietnamese');
assert.match(html, /DEFAULT_PLACE=\{en:'kh',vi:'vn',zh:'cn',km:'kh',th:'th'\}/, 'Vietnam is the Vietnamese locale default birthplace');
assert.match(html, /localeName=\{en:'English',vi:'Tiếng Việt',zh:'中文',km:'ខ្មែរ',th:'ไทย'\}/, 'admin labels Vietnamese accounts in the requested order');
assert.match(html, /family=Be\+Vietnam\+Pro:wght@400;500;600;700/, 'Mini App requests the required Be Vietnam Pro weights');
assert.match(html, /:lang\(vi\)\{--sans:"Be Vietnam Pro",/, 'Mini App Vietnamese body text prefers Be Vietnam Pro');
assert.match(html, /id="consent" type="checkbox" checked/, 'Save account is selected by default');
for (const locale of ['en', 'vi', 'zh', 'km', 'th']) {
  assert.ok(copy.T[locale].startConsentText, `T.${locale}.startConsentText is present`);
  assert.ok(copy.T[locale].languageMenuLabel, `T.${locale}.languageMenuLabel is present`);
  for (const key of ['datePlaceholder', 'dateDialogTitle', 'dateYear', 'dateMonth', 'dateDay', 'dateCancel', 'dateConfirm']) {
    assert.ok(copy.T[locale][key], `T.${locale}.${key} is present`);
  }
}
assert.match(html, /id="start-reading"[\s\S]+id="consent-panel"[\s\S]+class="moon-art"/, 'home orders start action, optional consent, then illustration');
assert.doesNotMatch(html, /id="continue"/, 'standalone Continue with Telegram action is removed');
assert.match(html, /function beginReading\(\)[\s\S]+saveOwnAccount\(button,'startReading'\)[\s\S]+startReading\(\)/, 'start action attempts consent before reading without blocking the reading call');
assert.match(html, /function syncTelegramMainButton\(\)[\s\S]+button\.setText\(tr\('startReading'\)\)/, 'Telegram MainButton shares the localized start action');
assert.match(html, /id="user-entry"[\s\S]+id="me-view"/, 'header account entry and My account view are present');
assert.match(html, /location\.hash==='\#\/me'/, 'My account uses the #/me route');
assert.equal((html.match(/\/api\/telegram\/consent/g) || []).length, 1,
  'the explicit save action is the only client path to the consent endpoint');
assert.doesNotMatch(html, /\bconfirm\s*\(/, 'account deletion uses the app dialog instead of native confirm');
assert.doesNotMatch(html, /id="answer-date"[^>]+type="date"/, 'birth date no longer uses the native date input');
assert.match(html, /id="date-dialog"[\s\S]{0,100}role="dialog" aria-modal="true"/, 'birth-date picker is a modal dialog');
assert.equal((html.match(/data-wheel="(?:year|month|day)" role="listbox"/g) || []).length, 3, 'birth-date picker has three listboxes');
assert.match(html, /function telegramBack\(\)\{if\(!\$\('#date-dialog'\)\.hidden\)\{closeDateDialog\(\);return\}/, 'Telegram BackButton closes the birth-date picker first');

console.log('locales.test.mjs: all locale key sets and account UI invariants pass.');
