import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../haku.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length > 0, "haku.html must contain its inline application script");
for (const [, source] of inlineScripts) new vm.Script(source);
const start = html.indexOf("function fourPillars(");
const end = html.indexOf("\n  function buildReadingFacts", start);
assert.ok(start >= 0 && end > start, "fourPillars must exist in the inline script");
const fourPillars = vm.runInNewContext("(" + html.slice(start, end).trim() + ")");
const stems = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const branches = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const text = p => stems[p.stem] + branches[p.branch];

assert.equal(text(fourPillars(2000,1,1,12,0,0,false).day), "戊午");
const may1990 = fourPillars(1990,5,15,12,0,8,true);
assert.equal(text(may1990.year), "庚午");
assert.equal(text(may1990.month), "辛巳");
assert.equal(text(fourPillars(2024,2,4,10,0,8,true).year), "癸卯");
assert.equal(text(fourPillars(2024,2,4,20,0,8,true).year), "甲辰");
assert.equal(fourPillars(2024,2,4,12,0,8,false).hour, null);

const before23 = fourPillars(2000,1,1,22,30,8,true).day;
const after23 = fourPillars(2000,1,1,23,30,8,true).day;
assert.equal(after23.stem, (before23.stem + 1) % 10);
assert.equal(after23.branch, (before23.branch + 1) % 12);

console.log("bazi.test.mjs: all assertions passed");
