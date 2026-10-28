import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const artRoot = path.join(root, 'art', 'illustrations');
const scenes = JSON.parse(await readFile(path.join(artRoot, 'scenes.json'), 'utf8'));
const selected = JSON.parse(await readFile(path.join(artRoot, 'selected.json'), 'utf8'));
assert.equal(scenes.length, 51);
assert.deepEqual([1, 2, 3, 4, 5, 6].map(page => scenes.filter(scene => scene.page === page).length), [2, 5, 6, 16, 16, 5]);
assert.equal(scenes.filter(scene => scene.show_when.fallback).length, 1);
assert.equal(new Set(scenes.map(scene => scene.id)).size, 51);
for (const scene of scenes) {
  assert.deepEqual(Object.keys(scene), ['id', 'page', 'show_when'], `${scene.id} exposes no authoring text`);
  assert.match(scene.id, /^(?:p[1-6]-[a-z0-9-]+|fallback)$/);
  assert.ok(scene.show_when && Object.keys(scene.show_when).length, `${scene.id} has a show_when rule`);
}
assert.deepEqual([...new Set(scenes.filter(scene => [4, 5].includes(scene.page)).map(scene => scene.show_when.theme))], ['love', 'wealth', 'career', 'social']);

for (const reference of ['reference/moonlit-fox-lantern.webp', 'reference/moonlit-riverside-fox.webp']) {
  const file = path.join(artRoot, reference);
  const info = await stat(file);
  const header = await readFile(file);
  assert.ok(info.size <= 400 * 1024, `${reference} is at most 400KB`);
  assert.equal(header.subarray(0, 4).toString(), 'RIFF');
  assert.equal(header.subarray(8, 12).toString(), 'WEBP');
}

const review = await readFile(path.join(artRoot, 'review.html'), 'utf8');
assert.match(review, /private\/review-data\.js/, 'review data remains local');
assert.match(review, /\[1,2,3,4,5,6,0\]/, 'review groups scenes by story page and fallback');
assert.match(review, /scene\.note_zh/);
assert.match(review, /manifest\.output\.candidates_per_scene/);
assert.equal(selected.service, 'Codex image_gen');
assert.equal(selected.model, 'unspecified');
assert.deepEqual(Object.keys(selected.selections).sort(), scenes.map(scene => scene.id).sort(), 'selection covers all 51 scenes');
const published = [];
for (const scene of scenes) {
  assert.match(selected.selections[scene.id], new RegExp(`^candidates/${scene.id}/candidate-[1-4]\\.webp$`));
  for (const [width, limit] of [[640, 80 * 1024], [1080, 160 * 1024]]) {
    const name = `${scene.id}-${width}.webp`;
    const file = path.join(root, 'public', 'assets', 'story', name);
    const info = await stat(file);
    const header = await readFile(file);
    assert.ok(info.size <= limit, `${name} stays within its size limit`);
    assert.equal(header.subarray(0, 4).toString(), 'RIFF');
    assert.equal(header.subarray(8, 12).toString(), 'WEBP');
    published.push(name);
  }
}
assert.deepEqual((await readdir(path.join(root, 'public', 'assets', 'story'))).filter(name => name.endsWith('.webp') && name !== 'hosts-test-640.webp').sort(), published.sort(), 'only the 102 selected assets are published');

const missingPrompts = spawnSync(process.execPath, ['scripts/generate-illustrations.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, HAKU_ILLUSTRATION_PROMPTS: 'art/illustrations/not-present.json' } });
assert.notEqual(missingPrompts.status, 0, 'generation requires local authoring data');
assert.match(missingPrompts.stderr, /Illustration prompt manifest not found/);
const generator = await readFile(path.join(root, 'scripts', 'generate-illustrations.mjs'), 'utf8');
assert.match(generator, /HAKU_ILLUSTRATION_PROMPTS/);
assert.match(generator, /failures\.push\(scene\.id\)/);
assert.match(generator, /Failed scene ids:/, 'individual failures are summarized after the batch');
const builder = await readFile(path.join(root, 'scripts', 'build-illustrations.mjs'), 'utf8');
assert.match(builder, /width: 640, height: 640, limit: 80 \* 1024/);
assert.match(builder, /width: 1080, height: 1080, limit: 160 \* 1024/);

const html = await readFile(path.join(root, 'haku.html'), 'utf8');
const extractFunction = (name, nextName, context = {}) => {
  const start = html.indexOf(`function ${name}(`), end = html.indexOf(`\n  function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} is extractable`);
  return vm.runInNewContext(`(${html.slice(start, end).trim()})`, context);
};
const ELEMENTS = ['wood', 'fire', 'earth', 'metal', 'water'];
const THEME_KEYS = ['love', 'wealth', 'career', 'social'];
const sceneKeys = {
  love: { state: ['hoping', 'together', 'complicated', 'healing'], concern: ['clarity', 'letting-go', 'uncertainty', 'trust'] },
  wealth: { state: ['steady', 'tight', 'changing', 'planning'], concern: ['not-enough', 'risk', 'spending', 'security'] },
  career: { state: ['searching', 'weary', 'crossroads', 'pushing'], concern: ['unseen', 'wrong-choice', 'burnout', 'self-doubt'] },
  social: { state: ['new-friends', 'steady-circle', 'friction', 'lonely'], concern: ['speak-up', 'misunderstood', 'accommodating', 'let-go'] }
};
const READING_THEMES = { en: Object.fromEntries(THEME_KEYS.map(theme => [theme, {
  state: sceneKeys[theme].state.map(key => [key]), concern: sceneKeys[theme].concern.map(key => [key])
}])) };
const storyIllustrationId = extractFunction('storyIllustrationId', 'storyIllustrationCandidates', { ELEMENTS, THEME_KEYS, READING_THEMES });
const storyIllustrationCandidates = extractFunction('storyIllustrationCandidates', 'storyIllustrationSources');
const facts = { dayElement: 'metal', strongestStable: true, strongest: ['fire'], weeklyElement: 'wood' };
assert.equal(storyIllustrationId(0, facts, { date: '1990-05-15' }), 'p1-opening-a');
assert.equal(storyIllustrationId(0, facts, { date: '1990-05-16' }), 'p1-opening-b');
for (const element of ELEMENTS) assert.equal(storyIllustrationId(1, { ...facts, dayElement: element }, {}), `p2-daymaster-${element}`);
for (const element of ELEMENTS) assert.equal(storyIllustrationId(2, { ...facts, strongest: [element] }, {}), `p3-strongest-${element}`);
assert.equal(storyIllustrationId(2, { ...facts, strongest: ['fire', 'metal'] }, {}), 'p3-balanced');
assert.equal(storyIllustrationId(2, { ...facts, strongestStable: false, strongest: [] }, {}), 'p3-balanced');
for (const theme of THEME_KEYS) for (const [index, key] of sceneKeys[theme].state.entries()) {
  assert.equal(storyIllustrationId(3, facts, { theme, relationship: index }), `p4-${theme}-${key}`);
}
for (const theme of THEME_KEYS) for (const [index, key] of sceneKeys[theme].concern.entries()) {
  assert.equal(storyIllustrationId(4, facts, { theme, concern: index }), `p5-${theme}-${key}`);
}
for (const element of ELEMENTS) assert.equal(storyIllustrationId(5, { ...facts, weeklyElement: element }, {}, element), `p6-action-${element}`);
assert.match(html, /actionElement=facts\.weeklyElement/);
assert.match(html, /weeklyActions\[actionElement\]/, 'page six copy and illustration use the same actionElement variable');
assert.deepEqual(Array.from(storyIllustrationCandidates('p1-opening-a')), ['p1-opening-a', 'fallback']);
assert.deepEqual(Array.from(storyIllustrationCandidates('fallback')), ['fallback']);

console.log('illustrations.test.mjs: all assertions passed');
