#!/usr/bin/env node
// 項目ごとの「結果の出やすさ」を公平に近づけるための顔の選び直し。
//
//   node tools/balance.mjs [--size 48] [--cand a.json,b.json] [--apply]
//
// なぜ相関を下げるのか:
//   ランク正規化で各項目の分布は同じ一様分布にそろうので、
//   項目ごとの当てやすさの違いは「項目どうしの相関」でほぼ決まる。
//   実測でも 最大相関と当てやすさの相関は -0.78（tools/feature-report.mjs の値と比較）。
//   眉と目の距離↔眉の形が 0.83 のように強く相関していると、
//   どちらを重視しているのか切り分けられず、両方とも当てにくくなる。
//
// そこで「顔のパーツ12項目の、いちばん強い相関」を小さくする顔の組み合わせを探す。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, KEYS, FACE_KEYS } from '../src/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
const SIZE = Number(at('--size') ?? 48);
const APPLY = args.includes('--apply');
const CAND = (at('--cand') ?? '').split(',').filter(Boolean);

const poolPath = path.join(ROOT, 'data/faces.json');
const data = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
const pool = data.faces;
const extra = CAND.flatMap((p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')).faces);
const all = [...pool, ...extra];
const inPool = new Set(pool.map((f) => f.file));

/** 部分集合のランク正規化 → 顔パーツ12項目の相関 */
function corrOf(faces) {
  const n = faces.length;
  const v = {};
  for (const k of FACE_KEYS) {
    const idx = faces.map((_, i) => i).filter((i) => Number.isFinite(faces[i].raw?.[k]));
    idx.sort((a, b) => faces[a].raw[k] - faces[b].raw[k]);
    const col = new Array(n).fill(0.5);
    idx.forEach((i, r) => { col[i] = idx.length > 1 ? r / (idx.length - 1) : 0.5; });
    v[k] = col;
  }
  const pear = (a, b) => {
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / (Math.sqrt(da * db) || 1);
  };
  const out = [];
  for (let i = 0; i < FACE_KEYS.length; i++) {
    for (let j = i + 1; j < FACE_KEYS.length; j++) {
      out.push({ a: FACE_KEYS[i], b: FACE_KEYS[j], r: pear(v[FACE_KEYS[i]], v[FACE_KEYS[j]]) });
    }
  }
  return out;
}

// いちばん強い相関を主、平均を従に見る。
// 最大だけだと同点が多く、平均だけだと1組だけ極端に強い状態を見逃す。
function costOf(faces) {
  const c = corrOf(faces);
  const abs = c.map((x) => Math.abs(x.r));
  const max = Math.max(...abs);
  const mean = abs.reduce((s, x) => s + x, 0) / abs.length;
  return { max, mean, cost: max + mean * 0.5, pairs: c };
}

const show = (faces, label) => {
  const { max, mean, pairs } = costOf(faces);
  const name = (k) => FEATURES[KEYS.indexOf(k)].name;
  console.log(`${label}: ${faces.length}枚  最大相関 ${max.toFixed(2)}  平均相関 ${mean.toFixed(2)}`);
  pairs.slice().sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 5)
    .forEach((p) => console.log(`    ${name(p.a)} ↔ ${name(p.b)}  ${p.r.toFixed(2)}`));
  return { max, mean };
};

console.log(`候補 ${all.length}枚（いまのプール ${pool.length} + 追加候補 ${extra.length}）から ${SIZE}枚を選ぶ`);
console.log('');
show(pool, '選び直す前');
console.log('');

// 1. 全候補から貪欲に外していく
let keep = [...all];
while (keep.length > SIZE) {
  let best = null, bestCost = Infinity;
  for (const f of keep) {
    const c = costOf(keep.filter((x) => x !== f)).cost;
    if (c < bestCost) { bestCost = c; best = f; }
  }
  keep = keep.filter((x) => x !== best);
}
// 2. 入れ替えで詰める
let cur = costOf(keep).cost;
for (let pass = 0; pass < 6; pass++) {
  let moved = false;
  const out = all.filter((f) => !keep.includes(f));
  for (const drop of [...keep]) {
    for (const add of out) {
      const trial = keep.map((x) => (x === drop ? add : x));
      const c = costOf(trial).cost;
      if (c < cur - 1e-6) { keep = trial; cur = c; moved = true; break; }
    }
    if (moved) break;
  }
  if (!moved) break;
}

const after = show(keep, '選び直したあと');
console.log('');
const dropped = pool.filter((f) => !keep.includes(f));
const added = keep.filter((f) => !inPool.has(f.file));
console.log(`外す ${dropped.length}枚: ${dropped.map((f) => f.file).join(' ') || 'なし'}`);
console.log(`足す ${added.length}枚: ${added.map((f) => f.file).join(' ') || 'なし'}`);

const outPath = at('--out');
if (outPath) {
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify({ count: keep.length, faces: keep }, null, 1)}\n`);
  console.log(`選んだ ${keep.length}枚を ${outPath} に書き出しました`);
}

// どんな顔を作れば相関が切れるのか。
// 強く相関している2項目を中央値で4分割し、空いている組み合わせを示す。
console.log('');
console.log('相関を切るために足りない組み合わせ（いまのプール）');
const name = (k) => FEATURES[KEYS.indexOf(k)].name;
const side = (k, hi) => (hi ? FEATURES[KEYS.indexOf(k)].high : FEATURES[KEYS.indexOf(k)].low);
const top = costOf(pool).pairs.slice().sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 5);
for (const p2 of top) {
  const med = (k) => {
    const xs = pool.map((f) => f.raw[k]).filter(Number.isFinite).sort((x, y) => x - y);
    return xs[Math.floor(xs.length / 2)];
  };
  const ma = med(p2.a), mb = med(p2.b);
  const q = [[0, 0], [0, 0]];
  for (const f of pool) {
    if (!Number.isFinite(f.raw[p2.a]) || !Number.isFinite(f.raw[p2.b])) continue;
    q[f.raw[p2.a] >= ma ? 1 : 0][f.raw[p2.b] >= mb ? 1 : 0]++;
  }
  const cells = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([i, j]) => ({ i, j, n: q[i][j] }))
    .sort((x, y) => x.n - y.n);
  const want = cells.slice(0, 2).filter((c) => c.n <= pool.length / 8);
  console.log(`  ${name(p2.a)} ↔ ${name(p2.b)}  r=${p2.r.toFixed(2)}`);
  if (!want.length) { console.log('    大きな空きはありません'); continue; }
  for (const c of want) {
    console.log(`    「${side(p2.a, c.i === 1)}」かつ「${side(p2.b, c.j === 1)}」 … いま ${c.n}枚`);
  }
}

if (APPLY) {
  if (added.length) {
    console.log('');
    console.log('足す顔があるので --apply では書き換えません。先に analyze.mjs で取り込んでください。');
    process.exit(1);
  }
  const names = new Set(dropped.map((f) => f.file));
  for (const f of dropped) {
    const at2 = path.join(ROOT, 'data/faces', f.file);
    if (fs.existsSync(at2)) fs.unlinkSync(at2);
  }
  data.faces = data.faces.filter((f) => !names.has(f.file));
  data.count = data.faces.length;
  fs.writeFileSync(poolPath, `${JSON.stringify(data, null, 1)}\n`);
  console.log('');
  console.log(`${dropped.length}枚を外しました。残り ${data.faces.length}枚。`);
}
