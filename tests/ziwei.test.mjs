import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const vendorBytes = readFileSync(new URL('../public/assets/vendor/iztro-2.6.3.min.js', import.meta.url));
assert.equal(createHash('sha256').update(vendorBytes).digest('hex'), '6d31ad9eba2f2c94c3e277380b762c77d715e434ce60be6efd3a5d6d54a52d9b', 'the audited iztro 2.6.3 browser bundle is unchanged');
const vendor = vendorBytes.toString('utf8');
const vendorContext = { window: {}, self: {}, console, setTimeout, clearTimeout };
vendorContext.globalThis = vendorContext;
vm.createContext(vendorContext);
vm.runInContext(vendor, vendorContext, { filename: 'iztro-2.6.3.min.js' });
const astro = vendorContext.self.iztro.astro;
astro.config({ yearDivide: 'normal', horoscopeDivide: 'normal' });

const html = readFileSync(new URL('../haku.html', import.meta.url), 'utf8');
const extractFunction = (name, nextName, context = {}) => {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\n  function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} is available to the Mini App`);
  return vm.runInNewContext(`(${html.slice(start, end).trim()})`, context);
};
const table = html.match(/SOLAR_TERM_BASE_YEAR=(\d+),SOLAR_TERM_LAST_YEAR=(\d+),SOLAR_TERM_START=(-?\d+),SOLAR_TERM_DELTAS='([0-9a-z]+)'/);
const SOLAR_TERM_BASE_YEAR = Number(table[1]);
const SOLAR_TERM_START = Number(table[3]);
const SOLAR_TERM_MINUTES = [SOLAR_TERM_START];
for (let i = 0, minute = SOLAR_TERM_START; i < table[4].length; i += 3) SOLAR_TERM_MINUTES.push(minute += parseInt(table[4].slice(i, i + 3), 36));
const solarTermState = extractFunction('solarTermState', 'timeZoneParts', { SOLAR_TERM_MINUTES, SOLAR_TERM_BASE_YEAR });
const timeZoneParts = extractFunction('timeZoneParts', 'resolveLocalTime', { Intl, Date });
const resolveLocalTime = extractFunction('resolveLocalTime', 'fourPillars', { timeZoneParts, Intl, Date, RangeError });
const fourPillars = extractFunction('fourPillars', 'localTermOnDate', { solarTermState, resolveLocalTime, SOLAR_TERM_BASE_YEAR, SOLAR_TERM_LAST_YEAR: Number(table[2]) });
const PLACE_TZ = { kh: 'Asia/Phnom_Penh', th: 'Asia/Bangkok', vn: 'Asia/Ho_Chi_Minh', cn: 'Asia/Shanghai', sg: 'Asia/Singapore', my: 'Asia/Kuala_Lumpur' };
const standardBirthTime = extractFunction('standardBirthTime', 'ziweiTimeIndex', { resolveLocalTime, PLACE_TZ, Date });
const ziweiTimeIndex = extractFunction('ziweiTimeIndex', 'loadIztro');

const chinaDst = standardBirthTime({ date: '1990-05-15', time: '13:30', place: 'cn' });
assert.deepEqual({ year: chinaDst.year, month: chinaDst.month, day: chinaDst.day, hour: chinaDst.hour, minute: chinaDst.minute }, { year: 1990, month: 5, day: 15, hour: 12, minute: 30 });
assert.equal(ziweiTimeIndex(chinaDst.hour), 6, '13:30 China DST uses 12:30 standard time and the 午 index');
const chinaMidnight = standardBirthTime({ date: '1990-05-15', time: '00:30', place: 'cn' });
assert.deepEqual({ year: chinaMidnight.year, month: chinaMidnight.month, day: chinaMidnight.day, hour: chinaMidnight.hour, minute: chinaMidnight.minute }, { year: 1990, month: 5, day: 14, hour: 23, minute: 30 }, 'DST conversion can cross into the previous standard-time date');
const chinaMidnightChart = astro.bySolar(`${chinaMidnight.year}-${chinaMidnight.month}-${chinaMidnight.day}`, ziweiTimeIndex(chinaMidnight.hour), '男');
assert.deepEqual(Array.from(chinaMidnightChart.palaces.find((palace) => palace.name === '命宫').majorStars, (star) => star.name), ['天梁'], 'the cross-midnight chart uses 1990-5-14 rather than the civil date');
assert.match(html, /date=\[standard\.year,standard\.month,standard\.day\]\.join\('-'\)/, 'createZiweiChart passes the standard-time date to bySolar');
const cambodiaLate = standardBirthTime({ date: '1990-05-15', time: '23:30', place: 'kh' });
assert.deepEqual({ year: cambodiaLate.year, month: cambodiaLate.month, day: cambodiaLate.day, hour: cambodiaLate.hour, minute: cambodiaLate.minute }, { year: 1990, month: 5, day: 15, hour: 23, minute: 30 }, 'a place without DST keeps its civil date and time');
const chinaDayChart = astro.bySolar(`${chinaDst.year}-${chinaDst.month}-${chinaDst.day}`, ziweiTimeIndex(chinaDst.hour), '男');
const chinaSoul = chinaDayChart.palaces.find((palace) => palace.name === '命宫');
assert.deepEqual([chinaSoul.heavenlyStem + chinaSoul.earthlyBranch, Array.from(chinaSoul.majorStars, (star) => star.name), chinaDayChart.fiveElementsClass], ['丁亥', ['天梁'], '土五局'], 'the daytime DST fixture keeps the expected Life Palace');
assert.equal(ziweiTimeIndex(23), 12, '23:30 uses the late-Zi index');
assert.equal(ziweiTimeIndex(0), 0, '00:30 uses the early-Zi index');

const baziCrossMidnight = fourPillars(1990, 5, 15, 0, 30, 'Asia/Shanghai', true);
assert.equal('甲乙丙丁戊己庚辛壬癸'[baziCrossMidnight.day.stem] + '子丑寅卯辰巳午未申酉戌亥'[baziCrossMidnight.day.branch], '庚辰', 'BaZi applies its 23:00 day boundary to the same standard-time date');
assert.equal('甲乙丙丁戊己庚辛壬癸'[baziCrossMidnight.hour.stem] + '子丑寅卯辰巳午未申酉戌亥'[baziCrossMidnight.hour.branch], '丙子');

const leap = astro.bySolar('2020-5-23', 6, '女');
assert.match(leap.lunarDate, /闰四月/, 'a leap-fourth-month date produces a chart with the default iztro convention');
assert.equal(astro.bySolar('1930-1-1', 0, '男').palaces.length, 12, 'the 1930 lower boundary produces all palaces');
const today = new Date();
const todayChart = astro.bySolar(`${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`, 6, '女');
assert.equal(todayChart.palaces.length, 12, 'today produces all palaces');

const betweenNewYearAndSpring = astro.bySolar('1999-2-11', 6, '男');
assert.ok(betweenNewYearAndSpring.chineseDate.startsWith('戊寅 '), 'Zi Wei keeps the lunar 戊寅 year before Lunar New Year');
const baziYear = fourPillars(1999, 2, 11, 12, 0, 'Asia/Shanghai', true).year;
assert.equal('甲乙丙丁戊己庚辛壬癸'[baziYear.stem] + '子丑寅卯辰巳午未申酉戌亥'[baziYear.branch], '己卯', 'BaZi has already changed to 己卯 after Start of Spring');
assert.match(html, /紫微以农历正月初一换年，八字以立春换年/, 'the chart explains the different year boundaries');

const deterministic = () => JSON.stringify(astro.bySolar('1990-5-15', 6, '男').toJSON());
assert.equal(deterministic(), deterministic(), 'the same input produces an identical chart');

function soulFixture(date, timeIndex, gender) {
  const chart = astro.bySolar(date, timeIndex, gender);
  const soul = chart.palaces.find((palace) => palace.name === '命宫');
  return [chart.earthlyBranchOfSoulPalace, Array.from(soul.majorStars, (star) => star.name), chart.fiveElementsClass];
}

// Official fixture: https://github.com/SylarLong/iztro/blob/v2.6.3/src/__tests__/astro/astro.test.ts#L70-L84
assert.deepEqual(soulFixture('2000-8-16', 2, '女'), ['午', ['紫微'], '木三局']);
// Official fixture: https://github.com/SylarLong/iztro/blob/v2.6.3/src/__tests__/astro/astro.test.ts#L1062-L1070
assert.deepEqual(soulFixture('2023-4-10', 4, '女'), ['子', ['贪狼'], '金四局']);
// Official fixture: https://github.com/SylarLong/iztro/blob/v2.6.3/src/__tests__/astro/astro.test.ts#L861-L876
assert.deepEqual(soulFixture('1980-2-14', 0, '男'), ['丑', ['天府'], '水二局']);

console.log('ziwei.test.mjs: offline vendor, time convention, boundaries, leap month, year boundary, determinism, and official fixtures pass.');
