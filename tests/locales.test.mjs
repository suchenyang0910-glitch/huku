import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(ROOT, 'haku.html'), 'utf8');
const server = await readFile(join(ROOT, 'server.mjs'), 'utf8');
let source = html.slice(html.indexOf('const T ='), html.indexOf('const $='));
source = source.replace('const T =', 'globalThis.T =').replace('const F=', 'globalThis.F=').replace('const A=', 'globalThis.A=').replace('const ZIWEI_COPY=', 'globalThis.ZIWEI_COPY=').replace('const ZIWEI_LOCAL=', 'globalThis.ZIWEI_LOCAL=');
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
  compareShape(copy.ZIWEI_COPY.en, copy.ZIWEI_COPY[locale], `ZIWEI_COPY.${locale}`);
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
  for (const key of ['datePlaceholder', 'dateDialogTitle', 'dateYear', 'dateMonth', 'dateDay', 'dateCancel', 'dateConfirm', 'timePlaceholder', 'timeDialogTitle', 'timeHour', 'timeMinute', 'savedAnswers', 'profileTitle', 'profileEmpty', 'profileGender', 'saveProfile', 'deleteProfile', 'profileDeleteTitle', 'profileSaved', 'profileDeleted', 'profileTimeRequired', 'profileFormSaveError', 'profileHead', 'viewProfile', 'viewZiwei', 'myZiwei', 'ziweiTitle', 'ziweiUnavailable', 'ziweiNeedsTime', 'ziweiFootnote', 'ziweiLeapNote']) {
    assert.ok(copy.T[locale][key], `T.${locale}.${key} is present`);
  }
  for (const key of ['userProfileTitle', 'profileBirthDate', 'profileBirthTime', 'profileUnknownTime', 'profileTermSide', 'profilePlace', 'profileGender', 'profileRelationship', 'profileConcern', 'profileDuration', 'profileUpdatedAt']) {
    assert.ok(copy.A[locale][key], `A.${locale}.${key} is present`);
  }
}
assert.ok(Object.keys(copy.ZIWEI_COPY.en.themes).length === 14, 'all 14 major stars have reflective themes');
for (const locale of ['th', 'km']) {
  for (const brightness of ['庙', '旺', '得', '利', '平', '不', '陷']) {
    assert.notEqual(copy.ZIWEI_LOCAL[locale].brightness[brightness], copy.ZIWEI_LOCAL[locale].brightnessFallback, `${locale} localizes iztro brightness ${brightness} without using brightnessFallback`);
  }
  assert.equal(copy.ZIWEI_LOCAL[locale].brightness['不得地'], undefined, `${locale} does not retain the invalid 不得地 brightness key`);
}
assert.equal(copy.ZIWEI_LOCAL.en.main[11], 'Tian Liang (Protector)', 'English uses Haku pinyin and meaning for Tian Liang');
assert.equal(copy.ZIWEI_LOCAL.en.main[3], 'Wu Qu (Wealth & discipline)', 'English uses Haku pinyin and meaning for Wu Qu');
assert.deepEqual(Object.values(copy.ZIWEI_LOCAL.en.brightness), ['Brilliant', 'Strong', 'Gained', 'Favorable', 'Neutral', 'Weak', 'Fallen'], 'English brightness labels are readable words');
assert.deepEqual(Object.values(copy.ZIWEI_LOCAL.en.mutagen), ['Lu (Prosperity)', 'Quan (Power)', 'Ke (Recognition)', 'Ji (Challenge)'], 'English transformations use Haku terms');
assert.doesNotMatch(copy.T.km.ziweiFootnote, /Lichun/i, 'Khmer year-boundary note does not leave Lichun in English');
assert.match(copy.T.km.ziweiFootnote, /ចូលនិទាឃរដូវ \(立春\)/, 'Khmer year-boundary note names Start of Spring in Khmer');
for (const locale of ['en', 'vi', 'zh', 'km', 'th']) assert.equal(copy.F[locale].steps.length, 6, `${locale} has six questionnaire steps`);
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
assert.doesNotMatch(html, /id="answer-time"[^>]+type="time"/, 'birth time no longer uses the native time input');
assert.match(html, /id="wheel-dialog"[\s\S]{0,160}role="dialog" aria-modal="true"/, 'the shared wheel picker is a modal dialog');
assert.match(html, /date:\{columns:\['year','month','day'\]/, 'birth-date picker configures three columns');
assert.match(html, /time:\{columns:\['hour','minute'\]/, 'birth-time picker configures two columns');
assert.match(html, /function telegramBack\(\)\{if\(!\$\('#wheel-dialog'\)\.hidden\)\{closeWheelDialog\(\);return\}/, 'Telegram BackButton closes the shared wheel picker first');
assert.doesNotMatch(html, /addEventListener\('change',renderQuestion\)/, 'ordinary questionnaire fields do not redraw the whole question on change');
assert.match(html, /commit\(draft,trigger,target\)\{target\.time=[\s\S]{0,280}target===answers\)updateTimeZoneNotice\(\)/, 'time Confirm updates the existing trigger and zone notice locally');
assert.doesNotMatch(html, /\bCONSENT_VERSION\b/, 'Mini App does not duplicate the deployed consent version');
assert.match(html, /consentCurrent=account\.consent_current===true/, 'Mini App reads current consent from the account response');
assert.match(html, /consentCurrent=data\.consent_current===true/, 'Mini App reads renewed consent from the consent response');
assert.match(html, /void saveReadingProfile\(\)/, 'completing the questionnaire saves a profile without blocking the story');
assert.match(html, /id="reading-profile"[\s\S]+id="profile-form"/, 'My account includes the reading-profile editor');
assert.match(html, /data-profile-user/, 'admin users expose owner-only profile actions');
assert.match(html, /F\[lang\]\.birthPlaces\[profile\.place\]/, 'admin profile renders the localized place label');
assert.match(html, /F\[lang\]\.steps\[3\]\.options\[profile\.relationship\]/, 'admin profile renders localized questionnaire choices');
assert.match(html, /script\.src='\/assets\/vendor\/iztro-2\.6\.3\.min\.js'/, 'iztro is loaded dynamically from the pinned local asset');
assert.doesNotMatch(html, /<script[^>]+src="\/assets\/vendor\/iztro-2\.6\.3\.min\.js"/, 'iztro is not loaded by the home document');
assert.doesNotMatch(html, /Object\.entries\(profile\)/, 'admin profile does not expose raw keys and values');
const clientPlaces = html.match(/const PLACE_TZ=\{([^}]+)\}/)[1].match(/\b[a-z]{2}(?=:)/g).sort();
const serverPlaces = server.match(/const profilePlaces = Object\.freeze\(\[([^\]]+)\]\)/)[1].match(/[a-z]{2}/g).sort();
assert.deepEqual(clientPlaces, serverPlaces, 'client and server accept the same birthplace keys');

console.log('locales.test.mjs: all locale key sets and account UI invariants pass.');
