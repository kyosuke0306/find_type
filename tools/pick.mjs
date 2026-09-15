#!/usr/bin/env node
// 候補の顔から、プールの幅をいちばん広げるものを選ぶ。
//
//   node tools/analyze.mjs --from .cache/plain --out .cache/cand/faces --json .cache/cand/faces.json --gender female
//   node tools/pick.mjs .cache/cand/faces.json --count 6
//
// 文章で骨格を動かそうとすると顔が崩れる。だから狙って散らすのはやめ、
// かわいさだけを指定してたくさん作り、その中から実測値が離れているものを選ぶ。
//
// 選ぶ基準は「見分けられる段階数（実測の幅 ÷ ノイズ）」の合計。
// いま狭い項目を広げる顔ほど高く評価される。
import fs from 'node:fs';
import path from 'node:path';
import { FEATURES, KEYS, FACE_KEYS } from '../src/features.js';

const NOISE = { faceLength:8.43e-4, jawSharp:4.21e-4, eyeSize:2.28e-4, eyeTilt:2.37e-4,
  eyeDistance:3.35e-4, browEyeGap:1.49e-3, browAngle:1.02e-3, browArch:3.27e-4,
  noseWidth:3.42e-4, mouthWidth:1.44e-3, lipThick:6.21e-4, skinTone:4.83e-1,
  hairColor:5.02e-1, hairLength:8.14e-3, ageLook:2.42e-1 };

// 段階数はいくら増えても頭打ちにする。
// 1項目だけ極端に広い顔より、狭い項目を底上げする顔を選びたい。
const CAP = 40;

const args = process.argv.slice(2);
const candPath = args.find((a) => !a.startsWith('--'));
const at = args.indexOf('--count');
const want = at > 0 ? Number(args[at + 1]) : 6;
const poolAt = args.indexOf('--pool');
const poolPath = poolAt > 0 ? args[poolAt + 1] : 'data/faces.json';
if (!candPath) {
  console.error('使い方: node tools/pick.mjs <候補の faces.json> [--count 6] [--pool data/faces.json]');
  process.exit(1);
}

const pool = JSON.parse(fs.readFileSync(path.resolve(poolPath), 'utf8')).faces;
const cand = JSON.parse(fs.readFileSync(path.resolve(candPath), 'utf8')).faces;

/** 顔の集合の「見分けられる段階数」を項目ごとに返す */
const levelsOf = (faces) => Object.fromEntries(KEYS.map((k) => {
  const xs = faces.map((f) => f.raw?.[k]).filter(Number.isFinite);
  if (xs.length < 2) return [k, 0];
  return [k, Math.min(CAP, (Math.max(...xs) - Math.min(...xs)) / (NOISE[k] * 2))];
}));

// 顔のパーツを主役にする。髪と肌は元から幅があり、増やしても診断は良くならない。
const scoreOf = (faces) => {
  const lv = levelsOf(faces);
  return FACE_KEYS.reduce((s, k) => s + lv[k], 0) + KEYS.filter((k) => !FACE_KEYS.includes(k)).reduce((s, k) => s + lv[k], 0) * 0.2;
};

const before = scoreOf(pool);
const chosen = [];
const rest = [...cand];
const kept = [...pool];

while (chosen.length < want && rest.length) {
  let best = null, bestGain = 0;
  for (const c of rest) {
    const gain = scoreOf([...kept, c]) - scoreOf(kept);
    if (gain > bestGain) { bestGain = gain; best = c; }
  }
  if (!best) break;          // これ以上は幅が広がらない
  chosen.push({ face: best, gain: bestGain });
  kept.push(best);
  rest.splice(rest.indexOf(best), 1);
}

console.log(`候補 ${cand.length} 枚 → 残すとよい ${chosen.length} 枚`);
console.log('');
for (const { face, gain } of chosen) {
  // その顔がどの項目を広げたのか
  const without = kept.filter((f) => f !== face);
  const lvA = levelsOf(without), lvB = levelsOf([...without, face]);
  const helped = FACE_KEYS.map((k, i) => [FEATURES[KEYS.indexOf(k)].name, lvB[k] - lvA[k]])
    .filter(([, d]) => d > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  ${face.file}  +${gain.toFixed(1)}段階` + (helped.length ? `   ${helped.map(([n, d]) => `${n} +${d.toFixed(0)}`).join(' / ')}` : ''));
}
if (!chosen.length) console.log('  どれを足しても幅は広がりませんでした。');

console.log('');
const after = scoreOf(kept);
console.log(`顔のパーツの段階数の合計: ${before.toFixed(0)} → ${after.toFixed(0)}`);
console.log('');
console.log('いま狭い項目（残す顔を選んだあと）');
const lv = levelsOf(kept);
FACE_KEYS.map((k) => [FEATURES[KEYS.indexOf(k)].name, lv[k]])
  .sort((a, b) => a[1] - b[1]).slice(0, 5)
  .forEach(([n, v]) => console.log(`  ${n.padEnd(7)} ${v.toFixed(0)}段階`));
