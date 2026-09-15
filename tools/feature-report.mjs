#!/usr/bin/env node
// 特徴項目ごとの「結果の出やすさ」と「当てやすさ」を測る。
//
//   node tools/feature-report.mjs [問数] [仮想ユーザー数] [--pool data/faces.json]
//
// 仮想ユーザーは15項目のうち4項目を無作為に「重視する項目」として持つので、
// どの項目も本当は 4/15 = 26.7% の人にとって重要。
// そこから、その項目が結果に出る割合がどれだけずれるかを見る。
//
//   出やすさ  … その項目が結果の1位／上位3つに入る割合
//   当てやすさ… 本当に重視している人のうち、上位3つに出せた割合（再現率）
//   確からしさ… 上位3つに出したうち、本当に重視していた割合（適合率）
//
// 出やすさが 26.7% より大きく、かつ確からしさが低い項目は「出やすいだけ」。
// 段階数（実測の幅 ÷ 測定ノイズ）が足りない項目ほどそうなりやすい。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, KEYS, FACE_KEYS, normalizePool } from '../src/features.js';
import { fit, choosePair, updateStats, newStats, utilityDelta } from '../src/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOISE = { faceLength:8.43e-4, jawSharp:4.21e-4, eyeSize:2.28e-4, eyeTilt:2.37e-4,
  eyeDistance:3.35e-4, browEyeGap:1.49e-3, browAngle:1.02e-3, browArch:3.27e-4,
  noseWidth:3.42e-4, mouthWidth:1.44e-3, lipThick:6.21e-4, skinTone:4.83e-1,
  hairColor:5.02e-1, hairLength:8.14e-3, ageLook:2.42e-1 };

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const POS = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--pool');
const ROUNDS = Number(POS[0] ?? 45);
const TRIALS = Number(POS[1] ?? 400);
const poolAt = process.argv.indexOf('--pool');
const POOL_PATH = poolAt > 0 ? process.argv[poolAt + 1] : 'data/faces.json';
const faces = JSON.parse(fs.readFileSync(path.resolve(ROOT, POOL_PATH), 'utf8')).faces;
const pool = normalizePool(faces);

function makeUser(rand, nImportant = 4) {
  const idx = KEYS.map((_, i) => i).sort(() => rand() - 0.5).slice(0, nImportant);
  const s = KEYS.map(() => 0.05 + rand() * 0.1);
  const m = KEYS.map(() => 0.5);
  for (const i of idx) {
    s[i] = 1.8 + rand() * 3.2;
    const r = rand();
    m[i] = r < 0.42 ? rand() * 0.12 : r < 0.84 ? 0.88 + rand() * 0.12 : 0.42 + rand() * 0.16;
  }
  return { m, a: s.map(Math.log), keys: KEYS, important: idx };
}

const stat = KEYS.map(() => ({ first: 0, top3: 0, trueTop3: 0, hitTop3: 0 }));

for (let t = 0; t < TRIALS; t++) {
  const rand = mulberry(1000 + t);
  const user = makeUser(rand);
  const cmp = [];
  const stats = newStats();
  let model = null;
  for (let r = 0; r < ROUNDS; r++) {
    const [A, B] = choosePair(pool, r >= 6 ? model : null, stats, rand);
    const aWins = rand() < sigmoid(utilityDelta(user, A.v, B.v));
    cmp.push({ win: aWins ? A.v : B.v, lose: aWins ? B.v : A.v });
    updateStats(stats, A, B);
    if (r >= 5 && (r % 3 === 0 || r === ROUNDS - 1)) model = fit(cmp);
  }
  model = fit(cmp);

  // 本当に重視している上位3つ（重視度 × 理想値の偏りで並べる）
  const trueRank = user.important.slice().sort((x, y) =>
    Math.exp(user.a[y]) * Math.max(user.m[y], 1 - user.m[y]) ** 2
    - Math.exp(user.a[x]) * Math.max(user.m[x], 1 - user.m[x]) ** 2).slice(0, 3);
  const est = KEYS.map((_, i) => i).sort((x, y) => model.importance[y] - model.importance[x]);
  const estTop3 = est.slice(0, 3);

  stat[est[0]].first++;
  for (const i of estTop3) stat[i].top3++;
  for (const i of trueRank) {
    stat[i].trueTop3++;
    if (estTop3.includes(i)) stat[i].hitTop3++;
  }
}

const levels = (k) => {
  const xs = faces.map((f) => f.raw[k]).filter(Number.isFinite);
  return xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / (NOISE[k] * 2);
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const BASE = 3 / KEYS.length; // どの項目も、本当は 3/15 = 20% の割合で上位3つに入るはず
console.log(`${ROUNDS}問・仮想ユーザー${TRIALS}人・${POOL_PATH} ${faces.length}枚`);
console.log(`どの項目も本当は 1位 ${pct(1 / KEYS.length)} / 上位3つ ${pct(BASE)} の割合で出るのが公平な状態です。`);
console.log('');
console.log('項目        段階数   1位に出る  上位3つに出る   当てやすさ  確からしさ  かたより');
const rows = KEYS.map((k, i) => {
  const s = stat[i];
  return {
    k, i,
    name: FEATURES[i].name,
    lv: levels(k),
    first: s.first / TRIALS,
    top3: s.top3 / TRIALS,
    recall: s.trueTop3 ? s.hitTop3 / s.trueTop3 : 0,
    prec: s.top3 ? s.hitTop3 / s.top3 : 0,
  };
}).sort((a, b) => b.top3 - a.top3);

for (const r of rows) {
  const bias = r.top3 / BASE;
  const tag = FACE_KEYS.includes(r.k) ? '' : '  ←髪や肌';
  console.log(`${r.name.padEnd(8)}${String(Math.round(r.lv)).padStart(6)}${pct(r.first).padStart(11)}`
    + `${pct(r.top3).padStart(13)}${pct(r.recall).padStart(12)}${pct(r.prec).padStart(11)}`
    + `${('x' + bias.toFixed(2)).padStart(10)}${tag}`);
}
console.log('');
console.log('かたより = 上位3つに出る割合 ÷ 20%。1.0 なら公平、大きいほど出やすい項目。');
