#!/usr/bin/env node
// 顔写真フォルダを解析して、アプリが使う data/faces/*.jpg と data/faces.json を作る。
//
//   node tools/analyze.mjs --from <画像フォルダ>
//
// 各画像について face-api で顔検出・68点ランドマーク・年齢/性別推定を行い、
//  - 顔を中心にそろえた正方形にトリミング
//  - ランドマークの幾何量と画素統計から特徴量(raw)を実測
// する。raw はプール内での相対値へアプリ側で正規化される（src/features.js）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs';
import * as wasmBackend from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = { from: null, out: 'data/faces', json: 'data/faces.json', size: 480, minScore: 0.45, append: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--size') a.size = Number(argv[++i]);
    else if (k === '--min-score') a.minScore = Number(argv[++i]);
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--append') a.append = true;
  }
  if (!a.from) {
    console.error('使い方: node tools/analyze.mjs --from <画像フォルダ> [--out data/faces] [--size 480] [--append]');
    process.exit(1);
  }
  return a;
}

async function initModels() {
  const pkgDir = path.dirname(fileURLToPath(await import.meta.resolve('@vladmandic/face-api/package.json')));
  try {
    wasmBackend.setWasmPaths(path.join(ROOT, 'node_modules/@tensorflow/tfjs-backend-wasm/dist/') );
    await tf.setBackend('wasm');
    await tf.ready();
  } catch {
    await tf.setBackend('cpu');
    await tf.ready();
  }
  const modelDir = path.join(pkgDir, 'model');
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
  await faceapi.nets.ageGenderNet.loadFromDisk(modelDir);
  return tf.getBackend();
}

/* ---------- 幾何ユーティリティ ---------- */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const slice = (P, a, b) => P.slice(a, b + 1);

/** 目の傾きを打ち消した座標系にランドマークを回転させる（計測を頭の傾きから独立させる） */
function deroll(P) {
  const eyeR = mean(slice(P, 36, 41));
  const eyeL = mean(slice(P, 42, 47));
  const ang = Math.atan2(eyeL.y - eyeR.y, eyeL.x - eyeR.x);
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const o = mean([eyeR, eyeL]);
  return P.map((p) => {
    const dx = p.x - o.x, dy = p.y - o.y;
    return { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c };
  });
}

/**
 * 68点ランドマークから顔の形状特徴を実測する。
 * すべて両目間の距離 d または顔幅で割り、写真の大きさに依存しない量にしている。
 */
function measureGeometry(P0) {
  const P = deroll(P0);
  const eyeR = mean(slice(P, 36, 41));   // 画像左側 = 本人の右目
  const eyeL = mean(slice(P, 42, 47));
  const d = dist(eyeR, eyeL);
  const eyeMid = mean([eyeR, eyeL]);
  const chin = P[8];
  const faceW = dist(P[0], P[16]);

  const eyeOpen = (a, b, c, e) => Math.abs((P[a].y + P[b].y) / 2 - (P[c].y + P[e].y) / 2);
  const eyeH = (eyeOpen(37, 38, 41, 40) + eyeOpen(43, 44, 47, 46)) / 2;
  const eyeW = (dist(P[36], P[39]) + dist(P[42], P[45])) / 2;

  // 眉山が「眉頭-眉尻を結んだ線」からどれだけ持ち上がっているか
  const archOf = (inner, peak, outer) => {
    const t = (P[peak].x - P[inner].x) / ((P[outer].x - P[inner].x) || 1e-6);
    const lineY = P[inner].y + (P[outer].y - P[inner].y) * t;
    return (lineY - P[peak].y) / d;
  };

  return {
    faceLength: (chin.y - eyeMid.y) / faceW,
    jawSharp: -dist(P[5], P[11]) / faceW,
    eyeSize: eyeH / d,
    eyeTilt: ((P[39].y - P[36].y) + (P[42].y - P[45].y)) / 2 / d,
    eyeDistance: dist(P[39], P[42]) / faceW,
    browEyeGap: ((P[37].y - P[19].y) + (P[44].y - P[24].y)) / 2 / d,
    browAngle: -((P[17].y - P[21].y) + (P[26].y - P[22].y)) / 2 / d,
    browArch: (archOf(21, 19, 17) + archOf(22, 24, 26)) / 2,
    noseWidth: dist(P[31], P[35]) / d,
    mouthWidth: dist(P[48], P[54]) / d,
    lipThick: (Math.abs(P[62].y - P[51].y) + Math.abs(P[57].y - P[66].y)) / d,
    _eyeAspect: eyeH / eyeW,
    _d: d,
    _eyeMid: eyeMid,
    _chin: chin,
    _faceW: faceW,
  };
}

/* ---------- 画素からの計測（肌・髪） ---------- */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function samplePatch(px, W, H, cx, cy, r) {
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
      const i = (y * W + x) * 3;
      sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
    }
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n, n } : null;
}

/**
 * 切り出し済み画像の画素から、肌の明るさ・髪の明るさ・髪の長さを推定する。
 * 髪の長さは「頭頂部で採取した髪色に近い画素が、あごより下にどれだけ広がっているか」で測る。
 */
function measurePixels(px, W, H, geo, scale, ox, oy) {
  const toCrop = (p) => ({ x: Math.round((p.x - ox) * scale), y: Math.round((p.y - oy) * scale) });
  const d = geo._d * scale;
  const eyeMid = toCrop(geo._eyeMid);
  const chin = toCrop(geo._chin);

  // 頬（目と口の外側）から肌色を採る
  const cheekR = Math.max(3, Math.round(d * 0.22));
  const cheeks = [
    samplePatch(px, W, H, eyeMid.x - Math.round(d * 0.95), eyeMid.y + Math.round(d * 0.85), cheekR),
    samplePatch(px, W, H, eyeMid.x + Math.round(d * 0.95), eyeMid.y + Math.round(d * 0.85), cheekR),
  ].filter(Boolean);
  const skin = cheeks.length
    ? { r: mean(cheeks.map((c) => ({ x: c.r, y: 0 }))).x, g: mean(cheeks.map((c) => ({ x: c.g, y: 0 }))).x, b: mean(cheeks.map((c) => ({ x: c.b, y: 0 }))).x }
    : { r: 200, g: 170, b: 150 };

  // 生え際の上（頭頂寄り）から髪色を採る
  const hairY = Math.max(2, eyeMid.y - Math.round(d * 1.75));
  const hairPatch = samplePatch(px, W, H, eyeMid.x, hairY, Math.max(3, Math.round(d * 0.35)));
  const hair = hairPatch ?? skin;

  // 背景色は四隅から推定（生成画像は無地背景を想定）
  const corners = [
    samplePatch(px, W, H, 4, 4, 4), samplePatch(px, W, H, W - 5, 4, 4),
    samplePatch(px, W, H, 4, H - 5, 4), samplePatch(px, W, H, W - 5, H - 5, 4),
  ].filter(Boolean);
  const bg = corners.length ? {
    r: corners.reduce((s, c) => s + c.r, 0) / corners.length,
    g: corners.reduce((s, c) => s + c.g, 0) / corners.length,
    b: corners.reduce((s, c) => s + c.b, 0) / corners.length,
  } : { r: 255, g: 255, b: 255 };

  // あごより下の左右領域で「髪色に近い/背景でも肌でもない」画素の割合 = 髪の長さ
  const near = (i, c, tol) => (Math.abs(px[i] - c.r) + Math.abs(px[i + 1] - c.g) + Math.abs(px[i + 2] - c.b)) < tol;
  let hairPx = 0, total = 0;
  const y0 = Math.min(H - 1, chin.y), y1 = H;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      total++;
      if (near(i, hair, 110) && !near(i, bg, 70) && !near(i, skin, 80)) hairPx++;
    }
  }

  return {
    skinTone: -lum(skin.r, skin.g, skin.b),          // 高いほど小麦肌
    hairColor: lum(hair.r, hair.g, hair.b),          // 高いほど明るい髪
    hairLength: total ? hairPx / total : 0,          // 高いほどロング
    _skin: skin, _hair: hair, _bg: bg,
  };
}

/* ---------- メイン ---------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = await initModels();
  console.log(`face-api 準備完了 (backend: ${backend})`);

  const outDir = path.resolve(ROOT, args.out);
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.resolve(ROOT, args.json);

  let existing = [];
  if (args.append) {
    try { existing = JSON.parse(await fs.readFile(jsonPath, 'utf8')).faces ?? []; } catch { /* 初回 */ }
  }
  const known = new Set(existing.map((f) => f.source));

  const files = (await fs.readdir(args.from))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .slice(0, args.limit);

  const detOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: args.minScore });
  const faces = [...existing];
  let skipped = 0;

  for (const [n, file] of files.entries()) {
    const src = path.join(args.from, file);
    if (known.has(file)) continue;
    try {
      const buf = await fs.readFile(src);
      const work = await sharp(buf).removeAlpha().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .raw().toBuffer({ resolveWithObject: true });
      const { width: W0, height: H0 } = work.info;

      const t = tf.tensor3d(new Uint8Array(work.data), [H0, W0, 3]);
      const det = await faceapi.detectSingleFace(t, detOpts).withFaceLandmarks().withAgeAndGender();
      t.dispose();
      if (!det) { skipped++; console.log(`  [skip] 顔を検出できません: ${file}`); continue; }

      const geo = measureGeometry(det.landmarks.positions);
      const d = geo._d;

      // 頭と肩が入る正方形で切り出す（髪の長さを測るため顔だけにしない）
      const box = d * 4.6;
      const ox = Math.round(geo._eyeMid.x - box / 2);
      const oy = Math.round(geo._eyeMid.y - box * 0.42);
      const left = Math.max(0, ox), top = Math.max(0, oy);
      const right = Math.min(W0, ox + box), bottom = Math.min(H0, oy + box);
      if (right - left < box * 0.75 || bottom - top < box * 0.75) {
        skipped++; console.log(`  [skip] 顔が端に寄りすぎ: ${file}`); continue;
      }

      const id = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '') || `face${n}`;
      const outName = `${id}.jpg`;
      const cropped = sharp(buf).removeAlpha()
        .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) })
        .resize(args.size, args.size, { fit: 'cover' });
      await cropped.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(outDir, outName));

      const cropRaw = await cropped.clone().raw().toBuffer({ resolveWithObject: true });
      const scale = args.size / (right - left);
      const pix = measurePixels(cropRaw.data, cropRaw.info.width, cropRaw.info.height, geo, scale, left, top);

      const raw = {};
      for (const [k, v] of Object.entries(geo)) if (!k.startsWith('_')) raw[k] = v;
      for (const [k, v] of Object.entries(pix)) if (!k.startsWith('_')) raw[k] = v;
      raw.ageLook = det.age;

      faces.push({
        id, file: outName, source: file,
        gender: det.gender, genderProbability: Number(det.genderProbability.toFixed(3)),
        age: Number(det.age.toFixed(1)),
        detScore: Number(det.detection.score.toFixed(3)),
        raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(Number(v).toFixed(5))])),
      });
      if ((n + 1) % 10 === 0 || n === files.length - 1) {
        console.log(`  ${n + 1}/${files.length} 解析済み (採用 ${faces.length - existing.length} / スキップ ${skipped})`);
      }
    } catch (e) {
      skipped++;
      console.log(`  [skip] ${file}: ${e.message}`);
    }
  }

  await fs.writeFile(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: faces.length,
    faces,
  }, null, 1));
  const byGender = faces.reduce((m, f) => (m[f.gender] = (m[f.gender] ?? 0) + 1, m), {});
  console.log(`\n完了: ${faces.length} 枚 → ${path.relative(ROOT, jsonPath)}`);
  console.log(`  内訳: ${Object.entries(byGender).map(([g, c]) => `${g}=${c}`).join(' ')}  スキップ ${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
