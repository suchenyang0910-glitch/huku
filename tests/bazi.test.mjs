import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../haku.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length > 0, "haku.html must contain its inline application script");
for (const [, source] of inlineScripts) new vm.Script(source);
const extractFunction = (name, nextName, context = {}) => {
  const functionStart = html.indexOf(`function ${name}(`);
  const functionEnd = html.indexOf(`\n  function ${nextName}`, functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, `${name} must exist in the inline script`);
  return vm.runInNewContext("(" + html.slice(functionStart, functionEnd).trim() + ")", context);
};
const table = html.match(/SOLAR_TERM_BASE_YEAR=(\d+),SOLAR_TERM_LAST_YEAR=(\d+),SOLAR_TERM_START=(-?\d+),SOLAR_TERM_DELTAS='([0-9a-z]+)'/);
assert.ok(table, "embedded solar-term table must exist");
const SOLAR_TERM_BASE_YEAR = Number(table[1]), SOLAR_TERM_START = Number(table[3]), SOLAR_TERM_DELTAS = table[4];
const SOLAR_TERM_MINUTES = [SOLAR_TERM_START];
for (let i=0,minute=SOLAR_TERM_START;i<SOLAR_TERM_DELTAS.length;i+=3) SOLAR_TERM_MINUTES.push(minute+=parseInt(SOLAR_TERM_DELTAS.slice(i,i+3),36));
const solarTermState = extractFunction("solarTermState", "fourPillars", {SOLAR_TERM_MINUTES,SOLAR_TERM_BASE_YEAR});
const fourPillars = extractFunction("fourPillars", "localTermOnDate", {solarTermState});
const stems = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const branches = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const text = p => stems[p.stem] + branches[p.branch];
const elements = ["wood","fire","earth","metal","water"];
const stemElement = ["wood","wood","fire","fire","earth","earth","metal","metal","water","water"];
const branchElement = ["water","earth","wood","wood","earth","fire","fire","earth","metal","metal","earth","water"];
const analyzeElements = extractFunction("analyzeElements", "elementNarrative", {ELEMENTS:elements});
const elementNarrative = extractFunction("elementNarrative", "buildReadingFacts");
const localTermOnDate = extractFunction("localTermOnDate", "unknownTimePillars", {fourPillars,SOLAR_TERM_MINUTES});
const unknownTimePillars = extractFunction("unknownTimePillars", "analyzeElements", {fourPillars,localTermOnDate});
let localeSource = html.slice(html.indexOf("const T ="), html.indexOf("const $="));
localeSource = localeSource.replace("const T =", "globalThis.T =").replace("const F=", "globalThis.F=").replace("const A=", "globalThis.A=");
const localeCopy = {};
vm.runInNewContext(localeSource, localeCopy);

function elementFacts(pillars) {
  const counts = Object.fromEntries(elements.map(key => [key, 0]));
  for (const pillar of [pillars.year,pillars.month,pillars.day,pillars.hour]) {
    counts[stemElement[pillar.stem]]++;
    counts[branchElement[pillar.branch]]++;
  }
  const dayElement = stemElement[pillars.day.stem];
  return {counts,dayElement,...analyzeElements(counts,dayElement)};
}

assert.equal(text(fourPillars(2000,1,1,12,0,0,false).day), "戊午");
const may1990 = fourPillars(1990,5,15,12,0,8,true);
assert.equal(text(may1990.year), "庚午");
assert.equal(text(may1990.month), "辛巳");
const may1990Elements = elementFacts(may1990);
assert.deepEqual(Array.from(may1990Elements.strongest), ["fire","metal"]);
const may1990Narrative = elementNarrative(may1990Elements.strongest,"strongest",3,localeCopy.F.zh.story,localeCopy.F.zh.story.elementNames);
assert.match(may1990Narrative.label, /火/);
assert.match(may1990Narrative.label, /金/);
assert.equal(may1990Elements.weeklyElement, "wood");

const balanced1930 = elementFacts(fourPillars(1930,1,1,4,0,7,true));
assert.deepEqual(Array.from(balanced1930.strongest), ["fire","metal","water"]);
assert.equal(elementNarrative(balanced1930.strongest,"strongest",2,localeCopy.F.zh.story,localeCopy.F.zh.story.elementNames).text, localeCopy.F.zh.story.balancedLine);
assert.equal(balanced1930.weeklyElement, "earth", "Metal day master chooses Earth (生我) before Wood (我克) when weakest ties");
assert.equal(text(fourPillars(2024,2,4,10,0,8,true).year), "癸卯");
assert.equal(text(fourPillars(2024,2,4,20,0,8,true).year), "甲辰");
assert.equal(fourPillars(2024,2,4,12,0,8,false).hour, null);
const uncertainLiChun = unknownTimePillars(2024,2,4,8,"unknown");
assert.equal(uncertainLiChun.term.localTime, "16:27");
assert.deepEqual(Array.from(uncertainLiChun.pillarOptions.year, text), ["癸卯","甲辰"]);
assert.deepEqual(Array.from(uncertainLiChun.pillarOptions.month, text), ["乙丑","丙寅"]);
const afterLiChun = unknownTimePillars(2024,2,4,8,"after");
assert.equal(text(afterLiChun.pillars.year), "甲辰");
assert.equal(text(afterLiChun.pillars.month), "丙寅");
assert.equal(localTermOnDate(2024,2,5,8), null);

const before23 = fourPillars(2000,1,1,22,30,8,true).day;
const after23 = fourPillars(2000,1,1,23,30,8,true).day;
assert.equal(after23.stem, (before23.stem + 1) % 10);
assert.equal(after23.branch, (before23.branch + 1) % 12);

console.log("bazi.test.mjs: all assertions passed");
