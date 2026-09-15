#!/usr/bin/env node
// 候補の顔が「足りない組み合わせ」を埋めるかどうかを見る。
//
//   node tools/gap-check.mjs 候補.json [--pool data/faces.json]
//
// 幅（段階数）を広げるかどうかは tools/pick.mjs。
// こちらは項目どうしの相関を切るかどうかを見る。いま公平さを止めているのは相関のほう。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, KEYS, FACE_KEYS } from '../src/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const candPath = args.find((a) => !a.startsWith('--'));
const poolAt = args.indexOf('--pool');
const poolPath = poolAt > 0 ? args[poolAt + 1] : 'data/faces.json';
if (!candPath) {
  console.error('使い方: node tools/gap-check.mjs <候補の faces.json> [--pool data/faces.json]');
  process.exit(1);
}
const pool = JSON.parse(fs.readFileSync(path.resolve(ROOT, poolPath), 'utf8')).faces;
const cand = JSON.parse(fs.readFileSync(path.resolve(candPath), 'utf8')).faces;

const pear = (a, b) => {
  const m = (x) => x.reduce((t, v) => t + v, 0) / x.length;
  const ma = m(a), mb = m(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / (Math.sqrt(da * db) || 1);
};
const both = (fs_, a, b) => fs_.filter((f) => Number.isFinite(f.raw?.[a]) && Number.isFinite(f.raw?.[b]));
const corr = (fs_, a, b) => { const ok = both(fs_, a, b); return pear(ok.map((f) => f.raw[a]), ok.map((f) => f.raw[b])); };
const name = (k) => FEATURES[KEYS.indexOf(k)].name;
const side = (k, hi) => (hi ? FEATURES[KEYS.indexOf(k)].high : FEATURES[KEYS.indexOf(k)].low);
const med = (k) => { const xs = pool.map((f) => f.raw[k]).filter(Number.isFinite).sort((x, y) => x - y); return xs[Math.floor(xs.length / 2)]; };

const pairs = [];
for (let i = 0; i < FACE_KEYS.length; i++) {
  for (let j = i + 1; j < FACE_KEYS.length; j++) {
    pairs.push({ a: FACE_KEYS[i], b: FACE_KEYS[j], r: corr(pool, FACE_KEYS[i], FACE_KEYS[j]) });
  }
}
pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
const top = pairs.slice(0, 6);

// 埋めたい枠（空いている側）を作る
const gaps = [];
for (const p of top) {
  const ma = med(p.a), mb = med(p.b);
  const q = [[0, 0], [0, 0]];
  for (const f of both(pool, p.a, p.b)) q[f.raw[p.a] >= ma ? 1 : 0][f.raw[p.b] >= mb ? 1 : 0]++;
  const cells = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([i, j]) => ({ i, j, n: q[i][j] })).sort((x, y) => x.n - y.n);
  for (const c of cells.slice(0, 2)) {
    if (c.n > both(pool, p.a, p.b).length / 6) continue;
    gaps.push({ ...p, ai: c.i, bi: c.j, have: c.n, ma, mb });
  }
}

console.log(`プール ${pool.length}枚 / 候補 ${cand.length}枚`);
console.log(`いちばん強い相関 ${Math.abs(top[0].r).toFixed(2)}（${name(top[0].a)} ↔ ${name(top[0].b)}）`);
console.log('');
let anyHit = false;
for (const f of cand) {
  const hits = gaps.filter((g) => Number.isFinite(f.raw?.[g.a]) && Number.isFinite(f.raw?.[g.b])
    && (f.raw[g.a] >= g.ma ? 1 : 0) === g.ai && (f.raw[g.b] >= g.mb ? 1 : 0) === g.bi);
  const after = Math.abs(corr([...pool, f], top[0].a, top[0].b));
  if (hits.length) anyHit = true;
  console.log(`${f.file.padEnd(10)} 埋める枠 ${hits.length}件`
    + (hits.length ? `   ${hits.map((g) => `${side(g.a, g.ai === 1)}×${side(g.b, g.bi === 1)}(いま${g.have}枚)`).join(' / ')}` : ''));
}
console.log('');
const before = Math.abs(top[0].r);
const after = Math.abs(corr([...pool, ...cand], top[0].a, top[0].b));
console.log(`候補を全部足したときの最大相関: ${before.toFixed(3)} → ${after.toFixed(3)}`);
if (!anyHit) console.log('どれも空いている枠を埋めません。--decorrelate のプロンプトで作り直すのが早いです。');
