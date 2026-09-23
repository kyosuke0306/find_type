#!/usr/bin/env node
// 項目ごとの「結果への出やすさ」をそろえる係数を求める。
//
//   node tools/calibrate.mjs [問数] [仮想ユーザー数] [--pool data/faces.json]
//
// 仮想ユーザーは15項目のうち4項目を無作為に重視するので、どの項目も本来は
// 上位3つに 20% の割合で出るのが公平。ところが実測では x0.76〜x1.45 とばらつく。
//
// 原因は重視度 exp(a)*max(m,1-m)^2 の素の水準と散らばりが項目ごとに違うこと。
// 理想値 m が端に寄りやすい項目は max(m,1-m)^2 が最大4倍になるため、
// 重視していなくても上位に紛れ込む。逆に中央へ寄る項目は重視していても埋もれる。
//
// ここでは仮想ユーザーを回して重視度をため、上位3つに出る割合が
// どの項目も 20% になる係数を繰り返し法で求める。出力を src/calibration.js に貼る。
// プールを大きく変えたら測り直す。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, KEYS, normalizePool } from '../src/features.js';
import { fit, choosePair, updateStats, newStats, utilityDelta } from '../src/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POS = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--pool');
const ROUNDS = Number(POS[0] ?? 45);
const TRIALS = Number(POS[1] ?? 400);
const poolAt = process.argv.indexOf('--pool');
const POOL_PATH = poolAt > 0 ? process.argv[poolAt + 1] : 'data/faces.json';
const faces = JSON.parse(fs.readFileSync(path.resolve(ROOT, POOL_PATH), 'utf8')).faces;
const pool = normalizePool(faces);
const K = KEYS.length;
const TOP = 3;
const TARGET = TOP / K;   // 3/15 = 20%

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// 仮想ユーザーと学習手順は tools/feature-report.mjs と同じにする。
// 測る道具と直す道具がずれていると、直したつもりで直らない。
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

// 1回だけ回して重視度をためる。係数の探索は貯めた値の上でやるので速い。
const samples = [];
for (let t = 0; t < TRIALS; t++) {
  const rand = mulberry(1000 + t);
  const user = makeUser(rand);
  const cmp = [];
  // 顔ごとの贔屓（luckOf）も乱数を引く。newStats() のままだと Math.random に
  // 落ちて、同じ種でも毎回ちがう係数が出る（アプリ側は毎回ちがってよいので既定のまま）。
  const stats = newStats(rand);
  let model = null;
  for (let r = 0; r < ROUNDS; r++) {
    const [A, B] = choosePair(pool, r >= 6 ? model : null, stats, rand);
    const aWins = rand() < sigmoid(utilityDelta(user, A.v, B.v));
    cmp.push({ win: aWins ? A.v : B.v, lose: aWins ? B.v : A.v });
    updateStats(stats, A, B);
    if (r >= 5 && (r % 3 === 0 || r === ROUNDS - 1)) model = fit(cmp);
  }
  model = fit(cmp);
  // 本当に重視している上位3つ（feature-report と同じ並べ方）
  const trueRank = user.important.slice().sort((x, y) =>
    Math.exp(user.a[y]) * Math.max(user.m[y], 1 - user.m[y]) ** 2
    - Math.exp(user.a[x]) * Math.max(user.m[x], 1 - user.m[x]) ** 2).slice(0, 3);
  samples.push({ raw: model.rawImportance.slice(), trueTop3: trueRank });
  if ((t + 1) % 50 === 0) process.stderr.write(`  ${t + 1}/${TRIALS} 人\n`);
}
fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.cache/calib-samples.json'), JSON.stringify({ rounds: ROUNDS, pool: POOL_PATH, samples }));

/** 係数 c のときに各項目が上位3つに出る割合と、重視する人で出せた割合 */
function rates(c) {
  const top = new Array(K).fill(0);
  const hit = new Array(K).fill(0), nTrue = new Array(K).fill(0);
  for (const s of samples) {
    const inTop = new Set(s.raw.map((x, i) => [x * c[i], i]).sort((a, b) => b[0] - a[0]).slice(0, TOP).map((x) => x[1]));
    for (let i = 0; i < K; i++) {
      if (inTop.has(i)) top[i]++;
      if (s.trueTop3.includes(i)) { nTrue[i]++; if (inTop.has(i)) hit[i]++; }
    }
  }
  return {
    top: top.map((x) => x / samples.length),
    recall: hit.map((x, i) => (nTrue[i] ? x / nTrue[i] : 0)),
  };
}

const c = new Array(K).fill(1);
for (let step = 0; step < 400; step++) {
  const { top } = rates(c);
  for (let i = 0; i < K; i++) c[i] *= Math.pow(TARGET / Math.max(top[i], 1e-4), 0.25);
  const g = Math.exp(c.reduce((s, x) => s + Math.log(x), 0) / K);  // 全体の大きさは動かさない
  for (let i = 0; i < K; i++) c[i] /= g;
}

const before = rates(new Array(K).fill(1));
const after = rates(c);
const spread = (x) => Math.max(...x) / Math.min(...x);

console.log('');
console.log(`${ROUNDS}問・仮想ユーザー${TRIALS}人・${POOL_PATH} ${faces.length}枚`);
console.log('公平な状態は、どの項目も上位3つに 20.0% です。');
console.log('');
console.log('項目            出やすさ 前 → 後      当てやすさ 前 → 後    係数');
KEYS.map((k, i) => i).sort((a, b) => before.top[b] - before.top[a]).forEach((i) => {
  console.log('  ' + FEATURES[i].name.padEnd(12)
    + `${(before.top[i] * 100).toFixed(1)}% → ${(after.top[i] * 100).toFixed(1)}%`.padStart(16)
    + `${(before.recall[i] * 100).toFixed(1)}% → ${(after.recall[i] * 100).toFixed(1)}%`.padStart(22)
    + c[i].toFixed(3).padStart(9));
});
console.log('');
console.log(`出やすさの幅   ${spread(before.top).toFixed(2)}倍 → ${spread(after.top).toFixed(2)}倍`);
console.log(`当てやすさの幅 ${spread(before.recall).toFixed(2)}倍 → ${spread(after.recall).toFixed(2)}倍`);
console.log('');
console.log('src/calibration.js に貼る内容:');
console.log('export const SURFACE_BIAS = {');
KEYS.forEach((k, i) => console.log(`  ${k}: ${c[i].toFixed(4)},`));
console.log('};');
