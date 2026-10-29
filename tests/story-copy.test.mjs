import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../haku.html', import.meta.url), 'utf8');
const declaration = html.match(/const STORY_COPY=\{zh:(\{[\s\S]*\})\};\s+STORY_COPY\.en=/);
assert.ok(declaration, 'STORY_COPY declaration exists');
const zh = JSON.parse(declaration[1]);
const buildLocale = name => {
  const start = html.indexOf(`function ${name}(zh)`);
  const end = html.indexOf('\n  const STORY_COPY={zh:', start);
  assert.ok(start >= 0 && end > start, `${name} builder exists`);
  return vm.runInNewContext(html.slice(start, end) + `; ${name}`)(zh);
};
const STORY_COPY = {
  zh,
  en: buildLocale('buildEnglishStoryCopy'),
  vi: buildLocale('buildVietnameseStoryCopy'),
  th: buildLocale('buildThaiStoryCopy'),
  km: buildLocale('buildKhmerStoryCopy')
};
for (const lang of ['en','vi','th','km']) assert.match(html, new RegExp(`STORY_COPY\\.${lang}=build`), `${lang} is registered in STORY_COPY`);
const shape = value => Array.isArray(value) ? [...value].map(shape) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : typeof value;
const stringCount = value => typeof value === 'string' ? 1 : Array.isArray(value) ? value.reduce((count, item) => count + stringCount(item), 0) : value && typeof value === 'object' ? Object.values(value).reduce((count, item) => count + stringCount(item), 0) : 0;
const placeholders = /\{(?!(?:duration|a|b|elements|action|heart)\})[^}]+\}/;
const checkStrings = value => {
  if (typeof value === 'string') {
    assert.ok(value.trim(), 'story strings are non-empty');
    assert.doesNotMatch(value, /\bundefined\b/, 'story template values are present');
    assert.doesNotMatch(value, placeholders, 'story placeholders are recognized');
  } else if (Array.isArray(value)) value.forEach(checkStrings);
  else if (value && typeof value === 'object') Object.values(value).forEach(checkStrings);
};
for (const [lang, copy] of Object.entries(STORY_COPY)) {
  assert.deepEqual(shape(copy), shape(zh), `${lang} keys match Chinese exactly`);
  checkStrings(copy);
}
const zhText = JSON.stringify(zh).replaceAll('其他','').replaceAll('他人','');
assert.doesNotMatch(zhText, /他|她/, 'Chinese story does not gender the other person');
assert.doesNotMatch(zhText, /一定会|注定|命中|必然|复合|发财|升职|投资|收益/, 'Chinese story avoids prohibited predictions and advice');
const enText = JSON.stringify(STORY_COPY.en);
assert.doesNotMatch(enText, /will definitely|destined|\bfate\b|get back together|get rich|\binvest\b/i, 'English story avoids prohibited predictions and advice');

const render = html.slice(html.indexOf('  function renderManga(){'), html.indexOf('\n  function changeMangaPage(', html.indexOf('  function renderManga(){')));
const pageTwo = render.slice(render.indexOf('else if(pageIndex===1){'), render.indexOf('else if(pageIndex===2){'));
const pageThree = render.slice(render.indexOf('else if(pageIndex===2){'), render.indexOf('else if(pageIndex===3){'));
assert.equal((pageTwo.match(/ziweiStoryLine\('soul'\)/g) || []).length, 1, 'story page 2 renders the Zi Wei soul line once');
assert.doesNotMatch(render, /if\(pageIndex===1&&storyZiwei/, 'no second Zi Wei soul line is appended');
assert.match(pageThree, /max.length===2\?paras\(p.maxPair/, 'page 3 selects the paired-element copy for a tie');
const pairCopy = STORY_COPY.en.common.p3;
const pairLabel = pairCopy.elementPair.replace('{a}', 'Fire').replace('{b}', 'Metal');
assert.match(pairCopy.maxPair.replace('{elements}', pairLabel), /Fire and Metal.*equally/i, 'fire and metal ties use the paired English narrative');

const len = text => [...text].length;
const words = text => text.trim().split(/\s+/).filter(Boolean).length;
const elementKeys = ['wood','fire','earth','metal','water'];
const actionKeys = [...elementKeys,'none'];
const longest = new Map();
const record = (lang, page, length, unit, combo) => {
  const key = `${lang}/${page}`;
  if (!longest.has(key) || longest.get(key).length < length) longest.set(key, {lang,page,length,unit,combo});
};
for (const [themeKey, zhTheme] of Object.entries(zh.themes)) {
  const enTheme = STORY_COPY.en.themes[themeKey];
  const p4Keys = Object.keys(zhTheme.p4).filter(key => key !== 'title');
  const concerns = Object.keys(zhTheme.p5).filter(key => key !== 'title');
  for (const state of p4Keys) for (const concern of concerns) for (const duration of zh.common.p5.duration) for (const element of elementKeys) for (const action of actionKeys) {
    const zhEntry=zhTheme.p5[concern][element],zhDuration=duration;
    const zhBody=zhEntry.text.replaceAll('{duration}',zhDuration)+(duration===zh.common.p5.duration[3]?zh.common.p5.seekSupport:'');
    const combo=`${themeKey}/${state}/${concern}/${duration}/${element}/${action}`;
    const zhCount=len(zhBody);assert.ok(zhCount<=220, `zh P5 <=220 (${combo}: ${zhCount})`);record('zh','P5',zhCount,'chars',combo);
    const enDuration=STORY_COPY.en.common.p5.duration[zh.common.p5.duration.indexOf(duration)];
    const enBody=enTheme.p5[concern][element].text.replaceAll('{duration}',enDuration)+(duration===zh.common.p5.duration[3]?STORY_COPY.en.common.p5.seekSupport:'');
    const enWords=words(enBody);assert.ok(enWords<=140, `en P5 <=140 words (${combo}: ${enWords})`);record('en','P5',enWords,'words',combo);
    const zhAction=zhTheme.p6.lanternAction[action],zhHeart=zhTheme.p6.lanternHeart[concern],zhLantern=zh.common.p6.lanternFormat.replace('{action}',zhAction).replace('{heart}',zhHeart),zhKeepsake=zhTheme.p5[concern][element].keepsake;
    const zhP6=zh.common.p6.opener+zhLantern+zh.common.p6.keepsakeLabel+zhKeepsake+zhTheme.p6.reflection,zhP6Count=len(zhP6);assert.ok(zhP6Count<=160, `zh P6 <=160 (${combo}: ${zhP6Count})`);record('zh','P6',zhP6Count,'chars',combo);
  }
}
console.log(`story-copy.test.mjs: 5 locale schemas (${Object.fromEntries(Object.entries(STORY_COPY).map(([lang, copy]) => [lang, stringCount(copy)]))} strings each), policy, rendering regression, and length checks passed; longest=${JSON.stringify([...longest.values()].sort((a,b)=>b.length-a.length).slice(0,3))}`);
