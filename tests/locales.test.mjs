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

for (const name of ['T', 'F', 'A']) compareShape(copy[name].en, copy[name].vi, name);
assert.match(html, /<option value="en">[^<]+<\/option><option value="vi">Tiếng Việt<\/option><option value="zh">[^<]+<\/option><option value="km">[^<]+<\/option><option value="th">[^<]+<\/option>/, 'language menu order is en, vi, zh, km, th');
assert.match(html, /tgLanguage\.startsWith\('vi'\)\?'vi'/, 'Telegram vi and vi-* languages default to Vietnamese');
assert.match(html, /DEFAULT_PLACE=\{en:'kh',vi:'vn',zh:'cn',km:'kh',th:'th'\}/, 'Vietnam is the Vietnamese locale default birthplace');
assert.match(html, /localeName=\{en:'English',vi:'Tiếng Việt',zh:'中文',km:'ខ្មែរ',th:'ไทย'\}/, 'admin labels Vietnamese accounts in the requested order');
assert.match(html, /family=Be\+Vietnam\+Pro:wght@400;500;600;700/, 'Mini App requests the required Be Vietnam Pro weights');
assert.match(html, /:lang\(vi\)\{--sans:"Be Vietnam Pro",/, 'Mini App Vietnamese body text prefers Be Vietnam Pro');

console.log('locales.test.mjs: Vietnamese and English key sets match recursively.');
