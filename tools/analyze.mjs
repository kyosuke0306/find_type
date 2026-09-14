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
  const a = { from: null, out: 'data/faces', json: 'data/faces.json', size: 480, minScore: 0.45, append: false, limit: Infinity, debug: null, multi: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--size') a.size = Number(argv[++i]);
    else if (k === '--min-score') a.minScore = Number(argv[++i]);
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--append') a.append = true;
    else if (k === '--multi') a.multi = true;
    else if (k === '--debug') a.debug = argv[++i] ?? '.cache/debug';
  }
  if (!a.from) {
    console.error('使い方: node tools/analyze.mjs --from <画像フォルダ> [--out data/faces] [--size 480] [--append] [--multi] [--debug .cache/debug]');
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

  // 画素の採取は「画像の上」ではなく「顔の上」を基準にする。
  // 顔が傾いた写真でも、頬と髪を狙った位置から採れるようにするため。
  const eyeR0 = mean(slice(P0, 36, 41));
  const eyeL0 = mean(slice(P0, 42, 47));
  const len = Math.hypot(eyeL0.x - eyeR0.x, eyeL0.y - eyeR0.y) || 1;
  const right = { x: (eyeL0.x - eyeR0.x) / len, y: (eyeL0.y - eyeR0.y) / len };
  const up = { x: right.y, y: -right.x };

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
    _eyeMid: mean([eyeR0, eyeL0]),
    _chin: P0[8],
    _faceW: faceW,
    _right: right,
    _up: up,
  };
}

/* ---------- 画素からの計測（肌・髪） ---------- */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const near2 = (a, b, tol) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < tol;

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
  const at = (sideways, upward) => ({
    x: Math.round(eyeMid.x + geo._right.x * sideways * d + geo._up.x * upward * d),
    y: Math.round(eyeMid.y + geo._right.y * sideways * d + geo._up.y * upward * d),
  });
  const cheekL = at(-0.95, -0.85), cheekRt = at(0.95, -0.85);
  const cheeks = [
    samplePatch(px, W, H, cheekL.x, cheekL.y, cheekR),
    samplePatch(px, W, H, cheekRt.x, cheekRt.y, cheekR),
  ].filter(Boolean);
  const skin = cheeks.length
    ? { r: mean(cheeks.map((c) => ({ x: c.r, y: 0 }))).x, g: mean(cheeks.map((c) => ({ x: c.g, y: 0 }))).x, b: mean(cheeks.map((c) => ({ x: c.b, y: 0 }))).x }
    : { r: 200, g: 170, b: 150 };

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

  // 髪の長さは「髪色に近く、背景でも肌でもない画素」を数えて測るため、
  // 背景が無地でないと成立しない。四隅がばらついていたら計測不能として扱う。
  const plainBg = corners.length === 4 && corners.every((c) => near2(c, bg, 70));

  // 髪色の採取。頭の大きさは顔ごとに違うので固定距離では外すことがある。
  // 額の上から頭頂・こめかみへ順に探索し、「肌でも背景でもない」最初の点を髪とみなす。
  const hairR = Math.max(3, Math.round(d * 0.3));
  const HAIR_PROBES = [[0, 1.15], [0, 1.45], [0, 1.75], [-0.95, 1.15], [0.95, 1.15], [-1.35, 0.55], [1.35, 0.55]];
  let hair = null, hairProbe = null;
  for (const [sx, uy] of HAIR_PROBES) {
    const q = at(sx, uy);
    const c = samplePatch(px, W, H, q.x, q.y, hairR);
    if (!c) continue;
    if (near2(c, skin, 55) || near2(c, bg, 60)) continue;
    hair = c; hairProbe = q; break;
  }

  // あごより下の左右領域で「髪色に近い/背景でも肌でもない」画素の割合 = 髪の長さ
  const near = (i, c, tol) => (Math.abs(px[i] - c.r) + Math.abs(px[i + 1] - c.g) + Math.abs(px[i + 2] - c.b)) < tol;
  let hairPx = 0, total = 0;
  if (hair && plainBg) {
    const y0 = Math.min(H - 1, chin.y), y1 = H;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        total++;
        if (near(i, hair, 110) && !near(i, bg, 70) && !near(i, skin, 80)) hairPx++;
      }
    }
  }

  // 採取点が背景や肌と見分けられないとき（薄毛・髪を上げている等）は
  // 髪の計測を「不能」として返す。正規化側で中央値扱いになる。
  return {
    skinTone: -lum(skin.r, skin.g, skin.b),                 // 高いほど小麦肌
    hairColor: hair ? lum(hair.r, hair.g, hair.b) : null,   // 高いほど明るい髪
    hairLength: hair && plainBg ? (total ? hairPx / total : 0) : null, // 高いほどロング（無地背景のときだけ）
    _skin: skin, _hair: hair, _bg: bg, _hairProbe: hairProbe, _plainBg: plainBg,
  };
}

/* ---------- 計測の目視確認用オーバーレイ ---------- */
/**
 * 切り出し画像の上に、検出したランドマークと肌/髪の採取位置、
 * 主要な実測値を描いた画像を書き出す。実測が破綻していないかを目で確かめるためのもの。
 */
function debugOverlay(size, P0, geo, raw, ox, oy, scale, hairProbe) {
  const toCrop = (p) => ({ x: (p.x - ox) * scale, y: (p.y - oy) * scale });
  const pts = P0.map(toCrop);
  const d = geo._d * scale;
  const eye = toCrop(geo._eyeMid);
  const chin = toCrop(geo._chin);
  const dot = (p, c, r = 2) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${c}"/>`;
  const patch = (x, y, r, c) => `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" fill="none" stroke="${c}" stroke-width="2"/>`;

  const groups = [[0, 16, '#4ad'], [17, 26, '#fd0'], [27, 35, '#0f8'], [36, 47, '#f44'], [48, 67, '#f8f']];
  const marks = groups.map(([a, b, c]) => pts.slice(a, b + 1).map((p) => dot(p, c)).join('')).join('');

  const cheekR = Math.max(3, d * 0.22);
  const at = (sideways, upward) => ({
    x: eye.x + geo._right.x * sideways * d + geo._up.x * upward * d,
    y: eye.y + geo._right.y * sideways * d + geo._up.y * upward * d,
  });
  const cl = at(-0.95, -0.85), cr = at(0.95, -0.85);
  // hairProbe はすでに切り出し座標なので変換しない
  const hp = hairProbe;
  const samples = [
    patch(cl.x, cl.y, cheekR, '#0ff'),
    patch(cr.x, cr.y, cheekR, '#0ff'),
    hp ? patch(hp.x, hp.y, Math.max(3, d * 0.3), '#ff0') : '',
    `<line x1="0" y1="${chin.y.toFixed(1)}" x2="${size}" y2="${chin.y.toFixed(1)}" stroke="#fff" stroke-width="1.5" stroke-dasharray="5 4"/>`,
  ].join('');

  const lines = ['faceLength', 'jawSharp', 'eyeSize', 'eyeTilt', 'eyeDistance', 'noseWidth', 'mouthWidth', 'lipThick', 'skinTone', 'hairColor', 'hairLength', 'ageLook']
    .map((k, i) => `<text x="6" y="${14 + i * 13}" font-size="11" fill="#fff" font-family="monospace">${k}=${Number.isFinite(raw[k]) ? raw[k].toFixed(3) : '計測不能'}</text>`).join('');

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="0" y="0" width="150" height="${14 + 12 * 13}" fill="rgba(0,0,0,.55)"/>
    ${lines}${samples}${marks}
    <text x="${size - 6}" y="${size - 8}" font-size="11" fill="#fff" text-anchor="end" font-family="monospace">水色=肌 黄=髪 破線=あご</text>
  </svg>`);
}

/**
 * 検出した顔1つ分を、切り出し・特徴量の実測・書き出しまで行う。
 * 1枚の画像に複数の顔がある場合はこれを顔の数だけ呼ぶ。
 */
async function extractFace(det, ctx) {
  const { workPng, W0, H0, id, source, args, outDir, debugDir } = ctx;
  const geo = measureGeometry(det.landmarks.positions);
  const d = geo._d;

  // 頭と肩が入る正方形で切り出す。
  // 髪の長さは「あごより下に髪がどれだけ広がっているか」で測るので、
  // あご下に十分な余白（切り出しの約35%）が残る大きさにする。
  const box = Math.round(d * 6.6);
  const ox = Math.round(geo._eyeMid.x - box / 2);
  const oy = Math.round(geo._eyeMid.y - box * 0.30);

  // 画像からはみ出す分は縁を引き伸ばして埋め、切り出し結果を必ず box × box にする。
  // こうしないと縦横比が変わり、ランドマークと画素の対応がずれる。
  const padL = Math.max(0, -ox), padT = Math.max(0, -oy);
  const padR = Math.max(0, ox + box - W0), padB = Math.max(0, oy + box - H0);
  if (Math.max(padL, padT, padR, padB) > box * 0.25) return { reason: '顔が画像の端に寄りすぎ' };

  const exLeft = ox + padL, exTop = oy + padT;
  const exW = box - padL - padR, exH = box - padT - padB;

  let region = sharp(workPng).extract({ left: exLeft, top: exTop, width: exW, height: exH });
  if (padL || padT || padR || padB) {
    region = region.extend({ left: padL, top: padT, right: padR, bottom: padB, extendWith: 'copy' });
  }
  const cropPng = await region.resize(args.size, args.size, { fit: 'fill' }).png().toBuffer();

  const outName = `${id}.jpg`;
  await sharp(cropPng).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(outDir, outName));
  const cropRaw = await sharp(cropPng).raw().toBuffer({ resolveWithObject: true });
  const scale = args.size / box;
  const pix = measurePixels(cropRaw.data, cropRaw.info.width, cropRaw.info.height, geo, scale, ox, oy);

  const raw = {};
  for (const [k, v] of Object.entries(geo)) if (!k.startsWith('_')) raw[k] = v;
  for (const [k, v] of Object.entries(pix)) if (!k.startsWith('_')) raw[k] = v;
  raw.ageLook = det.age;

  if (debugDir) {
    await sharp(cropPng)
      .composite([{ input: debugOverlay(args.size, det.landmarks.positions, geo, raw, ox, oy, scale, pix._hairProbe), top: 0, left: 0 }])
      .jpeg({ quality: 88 }).toFile(path.join(debugDir, outName));
  }

  return {
    face: {
      id, file: outName, source,
      gender: det.gender, genderProbability: Number(det.genderProbability.toFixed(3)),
      age: Number(det.age.toFixed(1)),
      detScore: Number(det.detection.score.toFixed(3)),
      raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(5)) : null])),
    },
  };
}

/* ---------- メイン ---------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = await initModels();
  console.log(`face-api 準備完了 (backend: ${backend})`);

  const outDir = path.resolve(ROOT, args.out);
  await fs.mkdir(outDir, { recursive: true });
  const debugDir = args.debug ? path.resolve(ROOT, args.debug) : null;
  if (debugDir) await fs.mkdir(debugDir, { recursive: true });
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
      // 検出も切り出しも同じ1枚から行う。sharp はチェーン内の2回目の resize を無視するため、
      // 「リサイズ済みの画像を作る」→「そこから切り出す」の2段階に分ける。
      const workPng = await sharp(buf).removeAlpha()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .png().toBuffer();
      const work = await sharp(workPng).raw().toBuffer({ resolveWithObject: true });
      const { width: W0, height: H0 } = work.info;

      const t = tf.tensor3d(new Uint8Array(work.data), [H0, W0, 3]);
      const dets = args.multi
        ? await faceapi.detectAllFaces(t, detOpts).withFaceLandmarks().withAgeAndGender()
        : [await faceapi.detectSingleFace(t, detOpts).withFaceLandmarks().withAgeAndGender()].filter(Boolean);
      t.dispose();
      if (!dets.length) { skipped++; console.log(`  [skip] 顔を検出できません: ${file}`); continue; }

      const baseId = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '') || `face${n}`;
      for (const [k, det] of dets.entries()) {
        const id = dets.length > 1 ? `${baseId}_${k + 1}` : baseId;
        const label = dets.length > 1 ? `${file} の${k + 1}人目` : file;
        const res = await extractFace(det, { workPng, W0, H0, id, source: file, args, outDir, debugDir });
        if (res.face) faces.push(res.face);
        else { skipped++; console.log(`  [skip] ${res.reason}: ${label}`); }
      }

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
  if (debugDir) console.log(`  計測の確認用画像: ${path.relative(ROOT, debugDir)}`);

  // 実測値が特徴ごとにちゃんとばらついているかを確認できるようにする
  if (faces.length >= 5) {
    console.log('\n実測値のばらつき (中央値 / 最小 - 最大):');
    for (const k of Object.keys(faces[0].raw)) {
      const xs = faces.map((f) => f.raw[k]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!xs.length) { console.log(`  ${k.padEnd(13)} 全件で計測不能`); continue; }
      const miss = faces.length - xs.length;
      const med = xs[Math.floor(xs.length / 2)];
      const flat = xs[0] === xs[xs.length - 1];
      console.log(`  ${k.padEnd(13)} ${med.toFixed(3).padStart(8)} / ${xs[0].toFixed(3)} - ${xs[xs.length - 1].toFixed(3)}`
        + `${flat ? '  ← 差がありません' : ''}${miss ? `  (計測不能 ${miss}件)` : ''}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
