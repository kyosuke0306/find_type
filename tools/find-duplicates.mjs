#!/usr/bin/env node
// 同じ人物の顔が複数入っていないか調べる。
//
//   node tools/find-duplicates.mjs <画像フォルダ> [--json data/faces.json]
//
// 同一人物が複数あると、その人の特徴に結果が引っ張られる。
// 顔認識モデルの特徴ベクトル同士の距離で判定する。
//
// 実写では 0.6 以下が同一人物の目安だが、同じ生成器で作った顔は
// 別人同士でもこの値を大きく下回る。そのため絶対値ではなく、
// そのプール自身の分布から外れて近い組を探す。
//
// ただし顔が似ていても実測値が違えば比較の材料として役に立つ。
// --json に解析結果を渡すと、見た目と実測値の両方で近い組だけを重複として挙げる。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs';
import * as wasmBackend from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';
import { KEYS, normalizePool } from '../src/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
const jsonAt = process.argv.indexOf('--json');
const jsonPath = jsonAt > 0 ? process.argv[jsonAt + 1] : null;
if (!dir) { console.error('使い方: node tools/find-duplicates.mjs <画像フォルダ> [--json data/faces.json]'); process.exit(1); }

// 実測値での距離（渡されたときだけ）
let featDist = null;
if (jsonPath) {
  const pool = normalizePool(JSON.parse(await fs.readFile(jsonPath, 'utf8')).faces);
  const bySource = Object.fromEntries(pool.map((f) => [f.source ?? f.file, f]));
  const byFile = Object.fromEntries(pool.map((f) => [f.file, f]));
  const get = (name) => bySource[name] ?? byFile[name] ?? byFile[name.replace(/\.[^.]+$/, '.jpg')];
  featDist = (a, b) => {
    const x = get(a), y = get(b);
    if (!x || !y) return null;
    return Math.sqrt(KEYS.reduce((s, k) => s + (x.v[k] - y.v[k]) ** 2, 0));
  };
}

const pkg = path.dirname(fileURLToPath(await import.meta.resolve('@vladmandic/face-api/package.json')));
try { wasmBackend.setWasmPaths(path.join(ROOT, 'node_modules/@tensorflow/tfjs-backend-wasm/dist/')); await tf.setBackend('wasm'); }
catch { await tf.setBackend('cpu'); }
await tf.ready();
const modelDir = path.join(pkg, 'model');
await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);

const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const items = [];
for (const f of files) {
  const raw = await sharp(path.join(dir, f)).removeAlpha()
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const t = tf.tensor3d(new Uint8Array(raw.data), [raw.info.height, raw.info.width, 3]);
  let det = null;
  for (const inputSize of [416, 608, 320, 512]) {
    det = await faceapi.detectSingleFace(t, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.45 }))
      .withFaceLandmarks().withFaceDescriptor();
    if (det) break;
  }
  t.dispose();
  if (det) items.push({ f, d: det.descriptor });
  else console.log(`  [skip] ${f}`);
}

const pairs = [];
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    let s = 0;
    for (let k = 0; k < items[i].d.length; k++) s += (items[i].d[k] - items[j].d[k]) ** 2;
    pairs.push({ a: items[i].f, b: items[j].f, dist: Math.sqrt(s) });
  }
}
pairs.sort((x, y) => x.dist - y.dist);
const ds = pairs.map((p) => p.dist);
const q = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(arr.length * t))];
const relative = q(ds, 0.02);

console.log(`\n${items.length} 枚 / ${pairs.length} 組`);
console.log(`見た目の距離: 最小 ${ds[0].toFixed(3)} / 下位2% ${relative.toFixed(3)} / 中央 ${q(ds, 0.5).toFixed(3)} / 最大 ${ds[ds.length - 1].toFixed(3)}`);
if (q(ds, 0.5) < 0.5) console.log('※ 中央値が実写の別人同士(0.5〜0.75)より小さく、プール全体が似た顔に寄っています。');

let fs2 = null, featCut = null;
if (featDist) {
  for (const p of pairs) p.feat = featDist(p.a, p.b);
  fs2 = pairs.map((p) => p.feat).filter((x) => x !== null).sort((a, b) => a - b);
  featCut = q(fs2, 0.10);
  console.log(`実測値の距離: 最小 ${fs2[0].toFixed(2)} / 下位10% ${featCut.toFixed(2)} / 中央 ${q(fs2, 0.5).toFixed(2)} / 最大 ${fs2[fs2.length - 1].toFixed(2)}`);
}

console.log('\n近い組み合わせ' + (featDist ? '（見た目 / 実測値）' : ''));
for (const p of pairs.slice(0, 8)) {
  const both = featDist && p.feat !== null && p.dist <= relative && p.feat <= featCut;
  const feat = featDist && p.feat !== null ? ` / ${p.feat.toFixed(2)}` : '';
  console.log(`  ${p.a} - ${p.b}  ${p.dist.toFixed(3)}${feat}${both ? '  ← 見た目も実測値も近い' : ''}`);
}

// 両方で近い組だけを重複とみなす。実測値が渡されていなければ見た目だけで判断する。
const close = pairs.filter((p) => featDist
  ? (p.feat !== null && p.dist <= relative && p.feat <= featCut)
  : p.dist <= relative);
const drop = new Set();
for (const p of close) if (!drop.has(p.a) && !drop.has(p.b)) drop.add(p.b);
console.log(drop.size
  ? `\n重複の候補: ${[...drop].join(' ')}（各組の片方）`
  : '\n重複はありません。');
