import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../haku.html', import.meta.url), 'utf8');
const match = html.match(/SOLAR_TERM_BASE_YEAR=(\d+),SOLAR_TERM_LAST_YEAR=(\d+),SOLAR_TERM_START=(-?\d+),SOLAR_TERM_DELTAS='([0-9a-z]+)'/);
assert.ok(match, 'embedded solar-term table must exist');
const baseYear = Number(match[1]), lastYear = Number(match[2]), start = Number(match[3]), encoded = match[4];
const minutes = [start];
for (let i=0,minute=start;i<encoded.length;i+=3) minutes.push(minute+=parseInt(encoded.slice(i,i+3),36));
assert.equal(baseYear, 1930);
assert.equal(lastYear, new Date().getUTCFullYear()+1);
assert.equal(minutes.length, (lastYear-baseYear+1)*12);

const samples = [
  {year:1959,term:0,utc:'1959-01-06T01:59Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:1,utc:'1959-02-04T13:43Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:2,utc:'1959-03-06T07:57Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:3,utc:'1959-04-05T13:04Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:4,utc:'1959-05-06T06:39Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:5,utc:'1959-06-06T11:01Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:6,utc:'1959-07-07T21:20Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:7,utc:'1959-08-08T07:05Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:8,utc:'1959-09-08T09:49Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:9,utc:'1959-10-09T01:11Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:10,utc:'1959-11-08T04:03Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1959,term:11,utc:'1959-12-07T20:38Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1959.pdf (JST)
  {year:1990,term:0,utc:'1990-01-05T14:33Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1990.pdf (JST)
  {year:1990,term:1,utc:'1990-02-04T02:14Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1990.pdf (JST)
  {year:1990,term:2,utc:'1990-03-05T20:19Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko1990.pdf (JST)
  {year:2000,term:0,utc:'2000-01-06T01:01Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko2000.pdf (JST)
  {year:2000,term:1,utc:'2000-02-04T12:40Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko2000.pdf (JST)
  {year:2000,term:2,utc:'2000-03-05T06:43Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/pdf/yoko2000.pdf (JST)
  {year:2010,term:0,utc:'2010-01-05T11:09Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/2010/rekiyou102.html (JST)
  {year:2010,term:1,utc:'2010-02-03T22:48Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/2010/rekiyou102.html (JST)
  {year:2010,term:2,utc:'2010-03-05T16:46Z'}, // Source: https://eco.mtk.nao.ac.jp/koyomi/yoko/2010/rekiyou102.html (JST)
  {year:2024,term:1,utc:'2024-02-04T08:27Z'}, // Source: https://www-ws.gov.taipei/001/Upload/439/relfile/21703/3425086/d6082728-c8bb-4be4-a15f-e507264ee47a.pdf (UTC+8: 16:27)
  {year:2026,term:0,utc:'2026-01-05T08:23Z'}, // Source: https://eco.mtk.nao.ac.jp/cgi-bin/koyomi/cande/phenomena_sy.cgi (JST)
  {year:2026,term:1,utc:'2026-02-03T20:02Z'}, // Source: https://eco.mtk.nao.ac.jp/cgi-bin/koyomi/cande/phenomena_sy.cgi (JST)
  {year:2026,term:2,utc:'2026-03-05T13:59Z'}, // Source: https://eco.mtk.nao.ac.jp/cgi-bin/koyomi/cande/phenomena_sy.cgi (JST)
];

for (const sample of samples) {
  const actual = minutes[(sample.year-baseYear)*12+sample.term];
  const expected = Date.parse(sample.utc)/60000;
  assert.ok(Math.abs(actual-expected)<=1, `${sample.year} term ${sample.term} differs by more than one minute`);
}

console.log(`solar-terms.test.mjs: ${samples.length} authoritative term times are within one minute.`);
