import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const artRoot = path.join(root, 'art', 'illustrations');
const scenes = JSON.parse(await readFile(path.join(artRoot, 'scenes.json'), 'utf8'));
const selected = JSON.parse(await readFile(path.join(artRoot, 'selected.json'), 'utf8'));
const args = process.argv.slice(2);
const allowMissingThemes = args.includes('--allow-missing-themes');
for (const arg of args) if (arg !== '--allow-missing-themes') throw new Error(`Unknown argument: ${arg}`);
const selectionIds = Object.keys(selected.selections || {});
const sceneIds = new Set(scenes.map(scene => scene.id));
const optionalThemes = new Set(['wealth', 'career', 'social']);
const requiredScenes = allowMissingThemes ? scenes.filter(scene => !optionalThemes.has(scene.show_when.theme)) : scenes;
const missing = requiredScenes.filter(scene => !selected.selections[scene.id]).map(scene => scene.id);
const unknown = selectionIds.filter(id => !sceneIds.has(id));
if (missing.length || unknown.length) throw new Error(`Selection must cover exactly the scene index. Missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`);
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { throw new Error('Playwright is required: npm install --no-save --package-lock=false playwright'); }

const candidateRoot = path.join(artRoot, 'candidates');
const outputRoot = path.join(root, 'public', 'assets', 'story');
await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  for (const scene of scenes.filter(scene => selected.selections[scene.id])) {
    const source = path.resolve(artRoot, selected.selections[scene.id]);
    if (!source.startsWith(candidateRoot + path.sep)) throw new Error(`${scene.id} selection must be inside art/illustrations/candidates`);
    const bytes = await readFile(source);
    const dataUrl = `data:image/${path.extname(source).slice(1) || 'webp'};base64,${bytes.toString('base64')}`;
    for (const target of [{ width: 640, height: 640, limit: 80 * 1024 }, { width: 1080, height: 1080, limit: 160 * 1024 }]) {
      let quality = .86;
      let output;
      while (quality >= .30) {
        const base64 = await page.evaluate(async ({ dataUrl, width, height, quality }) => {
          const image = new Image();
          image.src = dataUrl;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
          const drawWidth = image.naturalWidth * scale, drawHeight = image.naturalHeight * scale;
          canvas.getContext('2d').drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
          if (!blob || blob.type !== 'image/webp') throw new Error('Chromium could not encode WebP');
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, { dataUrl, ...target, quality });
        output = Buffer.from(base64, 'base64');
        if (output.length <= target.limit) break;
        quality -= .04;
      }
      if (!output || output.length > target.limit) throw new Error(`${scene.id}-${target.width}.webp exceeds ${target.limit} bytes at minimum quality`);
      const destination = path.join(outputRoot, `${scene.id}-${target.width}.webp`);
      await writeFile(destination, output);
      console.log(`${path.relative(root, destination)} ${output.length} bytes`);
    }
  }
} finally {
  await browser.close();
}
