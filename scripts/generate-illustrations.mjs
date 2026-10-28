import { readFile, mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const artRoot = path.join(root, 'art', 'illustrations');
const promptFile = path.resolve(root, process.env.HAKU_ILLUSTRATION_PROMPTS || path.join(artRoot, 'private', 'manifest.json'));
let manifest;
try { manifest = JSON.parse(await readFile(promptFile, 'utf8')); }
catch (error) {
  if (error.code === 'ENOENT') throw new Error(`Illustration prompt manifest not found: ${promptFile}. Keep it locally under art/illustrations/private/ or set HAKU_ILLUSTRATION_PROMPTS.`);
  throw error;
}
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const allowedArgs = new Set(['--yes', '--only', ...(only ? [only] : [])]);
for (const arg of args) if (!allowedArgs.has(arg)) throw new Error(`Unknown argument: ${arg}`);
if (onlyAt >= 0 && !only) throw new Error('--only requires a scene id');

const scenes = only ? manifest.scenes.filter(scene => scene.id === only) : manifest.scenes;
if (!scenes.length) throw new Error(`Unknown scene id: ${only}`);
const candidateRoot = path.join(artRoot, 'candidates');
const pending = [];
for (const scene of scenes) {
  for (let number = 1; number <= manifest.output.candidates_per_scene; number++) {
    const file = path.join(candidateRoot, scene.id, `candidate-${number}.webp`);
    try { await access(file); } catch { pending.push({ scene, number, file }); }
  }
}

const unitPrice = Number(process.env.OPENAI_IMAGE_UNIT_PRICE_USD || '');
console.log(`${pending.length} image candidate(s) pending across ${scenes.length} scene(s).`);
for (const scene of scenes) {
  const count = pending.filter(item => item.scene.id === scene.id).length;
  if (count) console.log(`- ${scene.id}: ${count}`);
}
console.log(Number.isFinite(unitPrice) && unitPrice >= 0
  ? `Estimated cost: $${(pending.length * unitPrice).toFixed(2)} at $${unitPrice.toFixed(4)} per image.`
  : 'Estimated cost unavailable: set OPENAI_IMAGE_UNIT_PRICE_USD to your configured per-image price.');
if (!yes || !pending.length) {
  if (!yes) console.log('Dry run only. Add --yes to generate.');
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_IMAGE_MODEL;
if (!apiKey) throw new Error('OPENAI_API_KEY is required with --yes');
if (!model) throw new Error('OPENAI_IMAGE_MODEL is required with --yes');
const references = await Promise.all(manifest.references.map(async relative => ({
  name: path.basename(relative),
  bytes: await readFile(path.resolve(path.dirname(promptFile), relative))
})));

const failures = [];
for (const { scene, number, file } of pending) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', `${manifest.style}\n\n${scene.prompt}\n\n${manifest.avoid}`);
    form.set('size', manifest.output.size);
    form.set('quality', process.env.OPENAI_IMAGE_QUALITY || 'medium');
    form.set('output_format', 'webp');
    form.set('output_compression', '90');
    for (const reference of references) form.append('image[]', new Blob([reference.bytes], { type: 'image/webp' }), reference.name);
    console.log(`Generating ${scene.id} candidate ${number}/${manifest.output.candidates_per_scene}…`);
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Image API ${response.status}: ${body.error?.message || 'request failed'}`);
    const result = body.data?.[0];
    let bytes = result?.b64_json ? Buffer.from(result.b64_json, 'base64') : null;
    if (!bytes && result?.url) {
      const imageResponse = await fetch(result.url);
      if (!imageResponse.ok) throw new Error(`image download ${imageResponse.status}`);
      bytes = Buffer.from(await imageResponse.arrayBuffer());
    }
    if (!bytes?.length) throw new Error('Image API returned no image');
    await writeFile(file, bytes, { flag: 'wx' });
  } catch (error) {
    failures.push(scene.id);
    console.error(`Failed ${scene.id} candidate ${number}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`Failed scene ids: ${[...new Set(failures)].join(', ')}`);
  console.error('Rerun one scene with --only <id> --yes.');
  process.exitCode = 1;
} else console.log('Generation complete. Open art/illustrations/review.html to choose candidates.');
