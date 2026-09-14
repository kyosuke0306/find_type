#!/usr/bin/env node
// プールが特徴空間をどれだけ覆えているかを調べる。
//
//   node tools/coverage.mjs data/faces.json
//
// ここで出た弱点は  npm run generate -- --dry-run --fill data/faces.json
// で、それを補う画像のプロンプトに変換できる。
// 診断の精度は「項目ごとに十分な差があるか」と「項目どうしが独立しているか」で決まる。
import fs from 'node:fs';
import { FEATURES, KEYS, normalizePool } from '../src/features.js';

const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const raws = j.faces.map((f) => f.raw);
const pool = normalizePool(j.faces);

// 測定ノイズ（tools/noise-check.mjs の実測値）
const NOISE = { faceLength:1.55e-3, jawSharp:9.68e-4, eyeSize:5.43e-4, eyeTilt:4.84e-4,
  eyeDistance:5.24e-4, browEyeGap:2.31e-3, browAngle:2.18e-3, browArch:7.07e-4,
  noseWidth:7.47e-4, mouthWidth:3.34e-3, lipThick:1.50e-3, skinTone:7.46e-1,
  hairColor:1.59, hairLength:4.98e-3, ageLook:5.17e-1 };

console.log('項目ごとの状態');
console.log('  項目            見分けられる段階数  分布の偏り（下/中/上）');
const weak = [];
for (const [i, k] of KEYS.entries()) {
  const xs = raws.map((r) => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
  const range = xs[xs.length - 1] - xs[0];
  const levels = range / (NOISE[k] * 2);          // ノイズ2つ分を1段階とみなす
  const lo = xs[0], hi = xs[xs.length - 1];
  const t1 = lo + range / 3, t2 = lo + range * 2 / 3;
  const bins = [xs.filter((x) => x < t1).length, xs.filter((x) => x >= t1 && x < t2).length, xs.filter((x) => x >= t2).length];
  const skew = Math.max(...bins) / Math.max(1, Math.min(...bins));
  const mark = levels < 12 ? ' ← 段階が粗い' : skew >= 6 ? ' ← 片寄り' : '';
  if (mark) weak.push({ k, name: FEATURES[i].name, levels, bins, lo: FEATURES[i].low, hi: FEATURES[i].high, need: bins.indexOf(Math.min(...bins)) });
  console.log(`  ${FEATURES[i].name.padEnd(12)} ${levels.toFixed(0).padStart(6)}段階        ${bins.join(' / ')}${mark}`);
}

// 相関（正規化後）。強いと2つの項目を切り分けられない。
console.log('\n項目どうしの相関（強いほど切り分けにくい）');
const corr = [];
for (let a = 0; a < KEYS.length; a++) for (let b = a + 1; b < KEYS.length; b++) {
  const xs = pool.map((f) => f.v[KEYS[a]]), ys = pool.map((f) => f.v[KEYS[b]]);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  corr.push({ a: FEATURES[a].name, b: FEATURES[b].name, ka: KEYS[a], kb: KEYS[b], r: num / Math.sqrt(dx * dy) });
}
corr.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
for (const c of corr.slice(0, 6)) {
  console.log(`  ${c.a} ⇔ ${c.b}  ${c.r >= 0 ? '+' : ''}${c.r.toFixed(2)}${Math.abs(c.r) > 0.5 ? '  ← 切り分けにくい' : ''}`);
}
