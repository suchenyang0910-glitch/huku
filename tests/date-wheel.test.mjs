import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'haku.html'), 'utf8');

function extract(name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} is present before ${nextName}`);
  return html.slice(start, end);
}

const context = { Date };
vm.runInNewContext([
  extract('daysInMonth', 'isFuture'),
  extract('isFuture', 'clampDate'),
  extract('clampDate', 'formatBirthDate'),
  'globalThis.result={daysInMonth,isFuture,clampDate}'
].join('\n'), context);
const { daysInMonth, isFuture, clampDate } = context.result;

assert.equal(daysInMonth(2024, 2), 29, 'leap-year February has 29 days');
assert.equal(daysInMonth(2100, 2), 28, '2100 is not a leap year');
assert.deepEqual({ ...clampDate(1990, 2, 31) }, { year: 1990, month: 2, day: 28 }, 'invalid day clamps to the month');

const today = new Date(2026, 9, 27, 12);
assert.equal(isFuture(2026, 10, 27, today), false, 'today is selectable');
assert.equal(isFuture(2026, 10, 28, today), true, 'tomorrow is in the future');
assert.deepEqual({ ...clampDate(2026, 10, 28, today) }, { year: 2026, month: 10, day: 27 }, 'future day clamps to today');
assert.deepEqual({ ...clampDate(2027, 12, 31, today) }, { year: 2026, month: 10, day: 27 }, 'future date clamps to today');

console.log('date-wheel.test.mjs: date boundaries pass.');
