import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let SearchSunLongitude;
try {
  ({ SearchSunLongitude } = await import('astronomy-engine'));
} catch {
  throw new Error('Install the build-only MIT dependency first: npm install --no-save --ignore-scripts astronomy-engine@2.1.19');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'haku.html');
const FIRST_YEAR = 1930;
const LAST_YEAR = 2100;
const TERMS = [
  [0, 285], [1, 315], [2, 345], [3, 15], [4, 45], [5, 75],
  [6, 105], [7, 135], [8, 165], [9, 195], [10, 225], [11, 255],
];

const minutes = [];
for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
  for (const [month, longitude] of TERMS) {
    const result = SearchSunLongitude(longitude, new Date(Date.UTC(year, month, 1)), 12);
    if (!result) throw new Error(`No solar term found for ${year}-${month + 1} at ${longitude} degrees`);
    minutes.push(Math.round(result.date.getTime() / 60000));
  }
}

const deltas = minutes.slice(1).map((minute, index) => minute - minutes[index]);
if (deltas.some(delta => delta <= 0 || delta >= 36 ** 3)) throw new Error('Solar-term delta no longer fits the fixed three-character base36 encoding');
const encoded = deltas.map(delta => delta.toString(36).padStart(3, '0')).join('');
const generated = `  // solar-terms:start\n  const SOLAR_TERM_BASE_YEAR=${FIRST_YEAR},SOLAR_TERM_LAST_YEAR=${LAST_YEAR},SOLAR_TERM_START=${minutes[0]},SOLAR_TERM_DELTAS='${encoded}';\n  // solar-terms:end`;
const source = await readFile(TARGET, 'utf8');
const marker = /  \/\/ solar-terms:start[\s\S]*?  \/\/ solar-terms:end/;
if (!marker.test(source)) throw new Error('solar-term markers are missing from haku.html');
await writeFile(TARGET, source.replace(marker, generated));
console.log(`Embedded ${minutes.length} solar terms for ${FIRST_YEAR}-${LAST_YEAR}.`);
