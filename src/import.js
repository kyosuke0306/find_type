// ブラウザだけで顔写真を取り込む。
// 検出・ランドマーク・年齢/性別推定を face-api で行い、切り出しと画素の読み取りは canvas で行う。
// 特徴量の計算は Node 版（tools/analyze.mjs）と同じ src/measure.js を使う。

import * as faceapi from '../vendor/face-api.esm.js';
import { measureGeometry, measurePixels } from './measure.js';

const MODEL_URL = 'vendor/models';
const WORK = 1024;   // 検出に使う作業解像度
const OUT = 480;     // 書き出す顔画像の一辺

let modelsReady = null;

/** 実際に使われている計算方式。webgl なら GPU、cpu だと大幅に遅い。 */
export const backendName = () => faceapi.tf.getBackend();

/** モデルの読み込み（初回のみ。約2.3MB） */
export function loadModels(onStep = () => {}) {
  if (!modelsReady) {
    modelsReady = (async () => {
      onStep('計算環境を準備中…');
      // setBackend は失敗時に例外ではなく false を返す。
      // 戻り値を見ずに tf.ready() へ進むと、tfjs が内部で wasm 版を探しに行ってしまう。
      let ok = false;
      try { ok = await faceapi.tf.setBackend('webgl'); } catch { ok = false; }
      if (!ok) { try { ok = await faceapi.tf.setBackend('cpu'); } catch { ok = false; } }
      await faceapi.tf.ready();
      onStep('顔検出モデルを読み込み中…');
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      onStep('輪郭検出モデルを読み込み中…');
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      onStep('年齢・性別モデルを読み込み中…');
      await faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL);
    })().catch((e) => { modelsReady = null; throw e; });
  }
  return modelsReady;
}

/** 画像を作業解像度の canvas に描く。スマホ写真の回転情報も反映する。 */
async function toWorkCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const k = Math.min(1, WORK / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/**
 * 正方形に切り出す。画像からはみ出す部分は縁の画素を引き伸ばして埋め、
 * 結果を必ず size × size にする（縦横比が変わるとランドマークと画素の対応がずれるため）。
 */
function cropSquare(src, ox, oy, box, size) {
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d', { willReadFrequently: true });
  const W = src.width, H = src.height;
  const sx = Math.max(0, ox), sy = Math.max(0, oy);
  const ex = Math.min(W, ox + box), ey = Math.min(H, oy + box);
  const sw = ex - sx, sh = ey - sy;
  const k = size / box;
  const dx = (sx - ox) * k, dy = (sy - oy) * k;
  const dw = sw * k, dh = sh * k;
  const padR = size - dx - dw, padB = size - dy - dh;

  // 上下左右のふち
  if (dy > 0) g.drawImage(src, sx, sy, sw, 1, dx, 0, dw, dy);
  if (padB > 0) g.drawImage(src, sx, ey - 1, sw, 1, dx, dy + dh, dw, padB);
  if (dx > 0) g.drawImage(src, sx, sy, 1, sh, 0, dy, dx, dh);
  if (padR > 0) g.drawImage(src, ex - 1, sy, 1, sh, dx + dw, dy, padR, dh);
  // 四隅
  if (dx > 0 && dy > 0) g.drawImage(src, sx, sy, 1, 1, 0, 0, dx, dy);
  if (padR > 0 && dy > 0) g.drawImage(src, ex - 1, sy, 1, 1, dx + dw, 0, padR, dy);
  if (dx > 0 && padB > 0) g.drawImage(src, sx, ey - 1, 1, 1, 0, dy + dh, dx, padB);
  if (padR > 0 && padB > 0) g.drawImage(src, ex - 1, ey - 1, 1, 1, dx + dw, dy + dh, padR, padB);
  // 本体
  g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  return out;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/**
 * 画像ファイル1つを解析し、見つかった顔ごとの結果を返す。
 * @returns {Promise<{faces: Array, skipped: Array<string>}>}
 */
export async function analyzeFile(file, { multi = false, minScore = 0.45 } = {}) {
  await loadModels();
  const work = await toWorkCanvas(file);
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: minScore });

  const dets = multi
    ? await faceapi.detectAllFaces(work, opts).withFaceLandmarks().withAgeAndGender()
    : [await faceapi.detectSingleFace(work, opts).withFaceLandmarks().withAgeAndGender()].filter(Boolean);

  if (!dets.length) return { faces: [], skipped: ['顔を検出できませんでした'] };

  const faces = [], skipped = [];
  for (const [k, det] of dets.entries()) {
    const geo = measureGeometry(det.landmarks.positions);
    // 頭と肩が入る正方形。髪の長さを測るためあご下に余白を残す。
    const box = Math.round(geo._d * 6.6);
    const ox = Math.round(geo._eyeMid.x - box / 2);
    const oy = Math.round(geo._eyeMid.y - box * 0.30);
    const pad = Math.max(-ox, -oy, ox + box - work.width, oy + box - work.height, 0);
    if (pad > box * 0.25) { skipped.push('顔が画像の端に寄りすぎています'); continue; }

    const crop = cropSquare(work, ox, oy, box, OUT);
    const px = crop.getContext('2d').getImageData(0, 0, OUT, OUT).data;
    const pix = measurePixels(px, OUT, OUT, geo, OUT / box, ox, oy, 4);

    const raw = {};
    for (const [key, v] of Object.entries(geo)) if (!key.startsWith('_')) raw[key] = v;
    for (const [key, v] of Object.entries(pix)) if (!key.startsWith('_')) raw[key] = v;
    raw.ageLook = det.age;

    faces.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${k}`,
      blob: await toBlob(crop, 'image/jpeg', 0.82),
      gender: det.gender,
      genderProbability: Number(det.genderProbability.toFixed(3)),
      age: Number(det.age.toFixed(1)),
      detScore: Number(det.detection.score.toFixed(3)),
      raw: Object.fromEntries(Object.entries(raw).map(([key, v]) => [key, Number.isFinite(v) ? Number(v.toFixed(5)) : null])),
      addedAt: Date.now(),
    });
  }
  return { faces, skipped };
}
