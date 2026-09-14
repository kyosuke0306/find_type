#!/usr/bin/env node
// 顔プールが診断に使えるかを検証する。
//
//   node tools/noise-check.mjs <画像フォルダ>
//
// 同じ画像を少しずつ違う解像度で解析すると、特徴量がわずかにブレる。これが測定ノイズ。
// 「顔ごとの差」がこのノイズと同程度なら、その項目は診断してもノイズを読んでいるだけになる。
// 実測値の幅が狭く見えても、ノイズより十分大きければ問題ない。
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs';
import * as wasmBackend from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';
import { measureGeometry, measurePixels } from '../src/measure.js';


const dir = process.argv[2];
const pkg = path.dirname(new URL(await import.meta.resolve('@vladmandic/face-api/package.json')).pathname);
try { wasmBackend.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/dist/'); await tf.setBackend('wasm'); } catch { await tf.setBackend('cpu'); }
await tf.ready();
await faceapi.nets.tinyFaceDetector.loadFromDisk(path.join(pkg,'model'));
await faceapi.nets.faceLandmark68Net.loadFromDisk(path.join(pkg,'model'));
await faceapi.nets.ageGenderNet.loadFromDisk(path.join(pkg,'model'));
const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.45 });

async function one(file, res) {
  const png = await sharp(file).removeAlpha().resize({width:res,height:res,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  const raw = await sharp(png).raw().toBuffer({resolveWithObject:true});
  const {width:W,height:H} = raw.info;
  const t = tf.tensor3d(new Uint8Array(raw.data),[H,W,3]);
  const det = await faceapi.detectSingleFace(t, opts).withFaceLandmarks().withAgeAndGender(); t.dispose();
  if(!det) return null;
  const geo = measureGeometry(det.landmarks.positions);
  const pix = measurePixels(raw.data, W, H, geo, 3);
  const o = {};
  for (const [k,v] of Object.entries(geo)) if(!k.startsWith('_')) o[k]=v;
  for (const [k,v] of Object.entries(pix)) if(!k.startsWith('_')) o[k]=v;
  o.ageLook = det.age;
  return o;
}

const files = (await fs.readdir(dir)).filter(f=>/\.jpg$/.test(f)).sort().map(f=>path.join(dir,f));
const RES = [900, 1024, 1150];
const perFile = [];
for (const f of files) {
  const runs = [];
  for (const r of RES) { const o = await one(f, r); if(o) runs.push(o); }
  perFile.push(runs);
}
const keys = Object.keys(perFile[0][0]);
console.log('項目            顔ごとの差(SD)  測定ノイズ(SD)  比  判定');
for (const k of keys) {
  // 顔ごとの差: 各画像の平均値どうしのばらつき
  const means = perFile.map(rs => rs.map(o=>o[k]).filter(Number.isFinite))
                       .filter(v=>v.length).map(v=>v.reduce((a,b)=>a+b,0)/v.length);
  if (means.length < 3) { console.log(`${k.padEnd(14)} 計測不能が多く判定できません`); continue; }
  const mu = means.reduce((a,b)=>a+b,0)/means.length;
  const between = Math.sqrt(means.reduce((s,x)=>s+(x-mu)**2,0)/(means.length-1));
  // 測定ノイズ: 同じ画像を解像度違いで測ったときのばらつき
  const withins = perFile.map(rs => {
    const v = rs.map(o=>o[k]).filter(Number.isFinite);
    if (v.length<2) return null;
    const m = v.reduce((a,b)=>a+b,0)/v.length;
    return Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/(v.length-1));
  }).filter(x=>x!==null);
  const within = withins.reduce((a,b)=>a+b,0)/withins.length;
  const ratio = within ? between/within : Infinity;
  const verdict = ratio >= 3 ? 'OK' : ratio >= 1.5 ? '弱い' : 'ノイズに埋もれている';
  console.log(`${k.padEnd(14)} ${between.toExponential(2)}    ${within.toExponential(2)}   ${ratio.toFixed(1)}  ${verdict}`);
}
