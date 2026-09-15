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
import { measureGeometry, measurePixels, chooseBox } from '../src/measure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let MODEL_DIR = null;

// 検出の入力サイズはアンカーの都合で画像との相性がある。
// 顔が画面いっぱいに写っていると特定のサイズだけ検出できないことがあるため、
// 複数のサイズを順に試し、それでも駄目なら別方式（SSD）に切り替える。
const DET_SIZES = [416, 608, 320, 512];

async function detect(tensor, minScore, multi) {
  const run = async (opts) => multi
    ? await faceapi.detectAllFaces(tensor, opts).withFaceLandmarks().withAgeAndGender()
    : [await faceapi.detectSingleFace(tensor, opts).withFaceLandmarks().withAgeAndGender()].filter(Boolean);

  for (const inputSize of DET_SIZES) {
    const r = await run(new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minScore }));
    if (r.length) return r;
  }
  // 最後の手段。モデルが大きいので必要になったときだけ読み込む。
  if (!faceapi.nets.ssdMobilenetv1.isLoaded) await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  return run(new faceapi.SsdMobilenetv1Options({ minConfidence: Math.min(minScore, 0.3) }));
}

function parseArgs(argv) {
  const a = { from: null, out: 'data/faces', json: 'data/faces.json', size: 480, minScore: 0.45, append: false, limit: Infinity, debug: null, multi: false, gender: null, tier: 'cute' };
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
    else if (k === '--gender') a.gender = argv[++i];
    else if (k === '--tier') a.tier = argv[++i];
    else if (k === '--debug') a.debug = argv[++i] ?? '.cache/debug';
  }
  if (!a.from) {
    console.error('使い方: node tools/analyze.mjs --from <画像フォルダ> [--out data/faces] [--size 480] [--append] [--multi] [--gender female|male] [--tier cute|plain] [--debug .cache/debug]');
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
  MODEL_DIR = modelDir;
  return tf.getBackend();
}

/* ---------- 計測の目視確認用オーバーレイ ---------- */
/**
 * 切り出し画像の上に、検出したランドマークと肌/髪の採取位置、
 * 主要な実測値を描いた画像を書き出す。実測が破綻していないかを目で確かめるためのもの。
 */
function debugOverlay(size, P0, geo, raw, ox, oy, scale, pix) {
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
  const hp = pix._hairProbe ? toCrop(pix._hairProbe) : null;
  const scan = pix._scan;
  const samples = [
    patch(cl.x, cl.y, cheekR, '#0ff'),
    patch(cr.x, cr.y, cheekR, '#0ff'),
    hp ? patch(hp.x, hp.y, Math.max(3, d * 0.3), '#ff0') : '',
    scan ? (() => {
      const a = toCrop({ x: scan.x0, y: scan.y0 }), b = toCrop({ x: scan.x1, y: scan.y1 });
      const rect = `<rect x="${a.x.toFixed(1)}" y="${a.y.toFixed(1)}" width="${(b.x - a.x).toFixed(1)}" height="${(b.y - a.y).toFixed(1)}" fill="none" stroke="#0f0" stroke-width="1.5" stroke-dasharray="6 4"/>`;
      if (scan.yHair < 0) return rect;
      const h = toCrop({ x: scan.x0, y: scan.yHair }).y;
      return rect + `<line x1="${a.x.toFixed(1)}" y1="${h.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${h.toFixed(1)}" stroke="#0f0" stroke-width="3"/>`;
    })() : '',
    `<line x1="0" y1="${chin.y.toFixed(1)}" x2="${size}" y2="${chin.y.toFixed(1)}" stroke="#fff" stroke-width="1.2" stroke-dasharray="4 4"/>`,
  ].join('');

  const lines = ['faceLength', 'jawSharp', 'eyeSize', 'eyeTilt', 'eyeDistance', 'noseWidth', 'mouthWidth', 'lipThick', 'skinTone', 'hairColor', 'hairLength', 'ageLook']
    .map((k, i) => `<text x="6" y="${14 + i * 13}" font-size="11" fill="#fff" font-family="monospace">${k}=${Number.isFinite(raw[k]) ? raw[k].toFixed(3) : '計測不能'}</text>`).join('');

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="0" y="0" width="150" height="${14 + 12 * 13}" fill="rgba(0,0,0,.55)"/>
    ${lines}${samples}${marks}
    <text x="${size - 6}" y="${size - 8}" font-size="11" fill="#fff" text-anchor="end" font-family="monospace">水色=肌 黄=髪色 緑枠=走査域 緑線=髪の下端</text>
  </svg>`);
}

// ランドマークは解像度をわずかに変えるだけで少し動く。
// 1枚だけで測るとその揺れがそのまま測定ノイズになり、
// 「顔ごとの差 ÷ ノイズ」で決まる見分けられる段階数が伸びない。
// 近い解像度で何度か測って中央値を採ると、揺れが打ち消し合う。
// 元画像が 1024px なので、拡大にならない範囲で散らす。
const MEASURE_SIZES = [896, 944, 992, 1024];

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** 複数の解像度で測り、項目ごとに中央値を返す。顔が1つの画像のみ対象。 */
async function measureRobust(buf, minScore) {
  const runs = [];
  for (const size of MEASURE_SIZES) {
    const png = await sharp(buf).removeAlpha()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H } = raw.info;
    const t = tf.tensor3d(new Uint8Array(raw.data), [H, W, 3]);
    let dets = [];
    try { dets = await detect(t, minScore, false); } finally { t.dispose(); }
    if (dets.length !== 1) continue;
    const geo = measureGeometry(dets[0].landmarks.positions);
    const pix = measurePixels(raw.data, W, H, geo, 3);
    const o = {};
    for (const [k, v] of Object.entries(geo)) if (!k.startsWith('_')) o[k] = v;
    for (const [k, v] of Object.entries(pix)) if (!k.startsWith('_')) o[k] = v;
    o.ageLook = dets[0].age;
    runs.push(o);
  }
  if (runs.length < 3) return null;
  const out = {};
  for (const k of Object.keys(runs[0])) out[k] = median(runs.map((r) => r[k]));
  return out;
}

/**
 * 検出した顔1つ分を、切り出し・特徴量の実測・書き出しまで行う。
 * 1枚の画像に複数の顔がある場合はこれを顔の数だけ呼ぶ。
 */
async function extractFace(det, ctx) {
  const { workPng, W0, H0, id, source, args, outDir, debugDir } = ctx;
  const geo = measureGeometry(det.landmarks.positions);

  // 画素の計測は元画像に対して行う。切り出し枠の外まで見る必要があるため。
  const full = await sharp(workPng).raw().toBuffer({ resolveWithObject: true });
  const pix = measurePixels(full.data, full.info.width, full.info.height, geo, 3);

  // 表示用の切り出し。画像に収まる範囲でできるだけ広く取る。
  const { box, ox, oy, pad } = chooseBox(geo, W0, H0, pix._headTop);
  if (pad > box * 0.25) return { reason: '顔が画像の端に寄りすぎ' };

  const padL = Math.max(0, -ox), padT = Math.max(0, -oy);
  const padR = Math.max(0, ox + box - W0), padB = Math.max(0, oy + box - H0);
  const exLeft = ox + padL, exTop = oy + padT;
  const exW = box - padL - padR, exH = box - padT - padB;

  let region = sharp(workPng).extract({ left: exLeft, top: exTop, width: exW, height: exH });
  if (padL || padT || padR || padB) {
    // はみ出す分を埋めて、結果を必ず box × box にする。
    // 背景が無地なら背景色で埋めると継ぎ目が出ない。そうでなければ縁を引き伸ばす。
    const ext = { left: padL, top: padT, right: padR, bottom: padB };
    region = pix._plainBg && pix._bg
      ? region.extend({ ...ext, background: { r: Math.round(pix._bg.r), g: Math.round(pix._bg.g), b: Math.round(pix._bg.b) } })
      : region.extend({ ...ext, extendWith: 'copy' });
  }
  // sharp は extend を resize のあとに適用するため、同じ流れに resize をつなぐと
  // 埋めた分だけ縦横が伸びて正方形でなくなる。工程を分けて確実に box × box にする。
  const boxPng = await region.png().toBuffer();
  const boxMeta = await sharp(boxPng).metadata();
  if (boxMeta.width !== box || boxMeta.height !== box) {
    throw new Error(`切り出しが ${boxMeta.width}x${boxMeta.height} になりました (期待 ${box}x${box})`);
  }
  const cropPng = await sharp(boxPng).resize(args.size, args.size, { fit: 'fill' }).png().toBuffer();

  const outName = `${id}.jpg`;
  await sharp(cropPng).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(outDir, outName));

  const raw = {};
  for (const [k, v] of Object.entries(geo)) if (!k.startsWith('_')) raw[k] = v;
  for (const [k, v] of Object.entries(pix)) if (!k.startsWith('_')) raw[k] = v;
  raw.ageLook = det.age;
  // 複数解像度で測れていれば、そちらの中央値を採る（切り出しは 1024px のまま）
  if (ctx.robust) for (const [k, v] of Object.entries(ctx.robust)) if (Number.isFinite(v)) raw[k] = v;

  // 計測できなかった項目はプール中央の扱いになり、その顔だけ嘘の値が入る。
  // 黙って通すと気づけないので知らせる。
  const missing = Object.entries(raw).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k);

  if (debugDir) {
    await sharp(cropPng)
      .composite([{ input: debugOverlay(args.size, det.landmarks.positions, geo, raw, ox, oy, args.size / box, pix), top: 0, left: 0 }])
      .jpeg({ quality: 88 }).toFile(path.join(debugDir, outName));
  }

  return {
    missing,
    face: {
      id, file: outName, source,
      // かわいさの層。違う層どうしは並べない（src/model.js の choosePair）
      tier: args.tier,
      // 自動判定はショートヘアの女性を男性と誤りやすいので、--gender で上書きできる
      gender: args.gender ?? det.gender,
      genderProbability: args.gender ? 1 : Number(det.genderProbability.toFixed(3)),
      detectedGender: det.gender,
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

  // スマホから持ってきた画像は HEIC/HEIF のことがあるので受け付ける
  const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|gif)$/i;
  const all = await fs.readdir(args.from);
  const files = all.filter((f) => IMAGE_EXT.test(f)).sort().slice(0, args.limit);
  const ignored = all.filter((f) => !IMAGE_EXT.test(f) && !f.startsWith('.') && !f.endsWith('.txt') && !f.endsWith('.json'));
  if (ignored.length) console.log(`  対象外の拡張子のため無視: ${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? ` ほか${ignored.length - 5}件` : ''}`);
  if (!files.length) {
    console.error(`${args.from} に画像が見つかりません（対応形式: jpg png webp heic heif tiff gif）`);
    process.exit(1);
  }

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
      const dets = await detect(t, args.minScore, args.multi);
      t.dispose();
      if (!dets.length) { skipped++; console.log(`  [skip] 顔を検出できません: ${file}`); continue; }

      // id は顔ごとに一意でなければならない。重なると、結果に出す「好みに近い顔」が
      // 別人になったり、同じ顔を出しすぎない仕組みが効かなくなる。
      // --append で同じ名前の画像を取り込むと重なるので、必ず連番を足して避ける。
      const taken = new Set(faces.map((f) => f.id));
      let baseId = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '') || `face${n}`;
      if (taken.has(baseId)) {
        let k = 2;
        while (taken.has(`${baseId}_${k}`)) k++;
        baseId = `${baseId}_${k}`;
      }
      // 顔が1つの画像は、複数解像度で測って中央値を採る（ノイズが下がる）
      const robust = dets.length === 1 ? await measureRobust(buf, args.minScore) : null;

      for (const [k, det] of dets.entries()) {
        const id = dets.length > 1 ? `${baseId}_${k + 1}` : baseId;
        const label = dets.length > 1 ? `${file} の${k + 1}人目` : file;
        const res = await extractFace(det, { workPng, W0, H0, id, source: file, args, outDir, debugDir, robust });
        if (res.face) {
          faces.push(res.face);
          if (res.missing?.length) {
            console.log(`  [注意] ${label}: ${res.missing.join(', ')} を計測できませんでした（この項目は中央値の扱いになります）`);
          }
        } else { skipped++; console.log(`  [skip] ${res.reason}: ${label}`); }
      }

      if ((n + 1) % 10 === 0 || n === files.length - 1) {
        console.log(`  ${n + 1}/${files.length} 解析済み (採用 ${faces.length - existing.length} / スキップ ${skipped})`);
      }
    } catch (e) {
      skipped++;
      const heic = /\.hei[cf]$/i.test(file);
      console.log(`  [skip] ${file}: ${e.message.split('\n')[0]}`
        + (heic ? '\n         → sharp の標準ビルドは iPhone の HEIC(HEVC) を読めません。JPEG に変換してから渡してください。'
                + '\n            iPhone なら「設定 → カメラ → フォーマット → 互換性優先」、'
                + 'または PC へ転送するときに JPEG 変換する設定にすると避けられます。' : ''));
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
