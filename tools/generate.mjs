#!/usr/bin/env node
// Google Gemini / Imagen API で顔写真を生成する。
//
//   GEMINI_API_KEY=xxx node tools/generate.mjs --count 160 --out .cache/raw
//
// 診断の精度は「プールが特徴空間をどれだけ広くカバーするか」で決まるため、
// ランダムに生成せず、輪郭・目・眉・髪などの属性グリッドから
// 均等に組み合わせを引いてプロンプトを作る。
// 画素計測（肌/髪）を安定させるため、構図と背景は全カットで固定する。

import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://generativelanguage.googleapis.com/v1beta';

const AXES = {
  faceShape: ['round face', 'oval face', 'long narrow face', 'square jawline', 'heart-shaped face with pointed chin'],
  eyes: ['large round eyes', 'almond-shaped eyes', 'narrow monolid eyes', 'upturned eyes', 'droopy downturned eyes', 'wide-set eyes', 'close-set deep-set eyes'],
  brows: ['thick straight eyebrows', 'thin arched eyebrows', 'softly curved eyebrows', 'bold angular eyebrows'],
  nose: ['small button nose', 'straight narrow nose', 'wide rounded nose', 'high-bridged nose'],
  lips: ['thin lips', 'full plump lips', 'medium lips with defined cupid bow'],
  hair: ['very short cropped hair', 'short hair above the ears', 'chin-length bob', 'shoulder-length hair', 'long hair past the chest'],
  hairColor: ['jet black hair', 'dark brown hair', 'light brown hair', 'ash grey hair', 'blonde hair'],
  skin: ['fair pale skin', 'light skin', 'medium olive skin', 'tan brown skin', 'deep brown skin'],
  age: ['18 years old', '22 years old', '27 years old', '33 years old', '41 years old'],
};

const ETHNICITY = {
  eastasian: ['Japanese', 'Korean', 'Chinese'],
  mixed: ['Japanese', 'Korean', 'Chinese', 'Japanese', 'Southeast Asian', 'White European', 'Black', 'Latin American', 'Middle Eastern', 'mixed-race'],
  global: ['White European', 'Black', 'Latin American', 'South Asian', 'Middle Eastern', 'East Asian', 'Southeast Asian'],
};

// 全カット共通の構図指定。ここがぶれると肌色・髪の長さの実測が狂う。
const FRAMING = [
  'head and shoulders portrait photograph',
  'facing the camera directly, head straight, eyes looking at the camera',
  'neutral relaxed expression, mouth closed',
  'plain light grey seamless studio background',
  'soft even frontal lighting, no harsh shadows',
  'sharp focus, photorealistic, 50mm lens, natural skin texture',
  'no glasses, no hat, no jewelry, no visible makeup product, hair not covering the eyebrows',
].join(', ');

function parseArgs(argv) {
  const a = { count: 160, out: '.cache/raw', model: 'imagen-4.0-fast-generate-001', ethnicity: 'mixed', femaleRatio: 0.5, dryRun: false, list: false, concurrency: 3, seed: 12345 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--count') a.count = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--ethnicity') a.ethnicity = argv[++i];
    else if (k === '--female-ratio') a.femaleRatio = Number(argv[++i]);
    else if (k === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (k === '--seed') a.seed = Number(argv[++i]);
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--list-models') a.list = true;
  }
  return a;
}

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

/** 各軸を「シャッフルした袋から引いて、尽きたら詰め直す」方式で巡回させ、全値が均等に出るようにする */
function makeBag(list, rand) {
  let bag = [];
  return () => {
    if (!bag.length) {
      bag = list.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  };
}

/** 属性グリッドからプロンプトを作る。各軸が均等に現れるようにして特徴空間を広くカバーする。 */
function buildPrompts(n, opts) {
  const rand = mulberry(opts.seed);
  const eth = ETHNICITY[opts.ethnicity] ?? ETHNICITY.mixed;
  const bags = Object.fromEntries(Object.entries(AXES).map(([k, v]) => [k, makeBag(v, rand)]));
  const ethBag = makeBag(eth, rand);
  const out = [];
  for (let i = 0; i < n; i++) {
    const gender = i < Math.round(n * opts.femaleRatio) ? 'woman' : 'man';
    const pick = Object.fromEntries(Object.keys(AXES).map((k) => [k, bags[k]()]));
    const who = ethBag();
    const hair = gender === 'man' && /past the chest|shoulder-length/.test(pick.hair)
      ? (rand() < 0.7 ? 'short hair above the ears' : pick.hair) : pick.hair;
    const text = `A ${FRAMING}. A ${who} ${gender}, ${pick.age}, with a ${pick.faceShape}, ${pick.eyes}, ${pick.brows}, a ${pick.nose}, ${pick.lips}, ${hair}, ${pick.hairColor}, ${pick.skin}.`;
    out.push({ index: i, gender, text, attrs: { ...pick, hair, ethnicity: who } });
  }
  return out;
}

async function listModels(key) {
  const r = await fetch(`${API}/models?key=${key}&pageSize=200`);
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  for (const m of j.models ?? []) {
    if (/image|imagen/i.test(m.name)) console.log(`${m.name.replace('models/', '')}  [${(m.supportedGenerationMethods ?? []).join(',')}]`);
  }
}

/** Imagen (predict) と Gemini image (generateContent) の両方に対応する */
async function generateOne(key, model, prompt) {
  const isImagen = /imagen/i.test(model);
  const url = isImagen ? `${API}/models/${model}:predict?key=${key}` : `${API}/models/${model}:generateContent?key=${key}`;
  const body = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1', personGeneration: 'allow_adult' } }
    : { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } };

  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);

  const b64 = isImagen
    ? json.predictions?.[0]?.bytesBase64Encoded
    : json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new Error(`画像が返りませんでした: ${JSON.stringify(json).slice(0, 300)}`);
  return Buffer.from(b64, 'base64');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

  if (args.list) {
    if (!key) { console.error('GEMINI_API_KEY を設定してください'); process.exit(1); }
    return listModels(key);
  }

  const prompts = buildPrompts(args.count, args);
  if (args.dryRun) {
    prompts.slice(0, 8).forEach((p) => console.log(`[${p.index}] ${p.text}\n`));
    console.log(`... 全 ${prompts.length} 件（--dry-run のため生成はしていません）`);
    return;
  }
  if (!key) { console.error('GEMINI_API_KEY を設定してください（https://aistudio.google.com/apikey）'); process.exit(1); }

  const outDir = path.resolve(args.out);
  await fs.mkdir(outDir, { recursive: true });
  const meta = [];
  let done = 0, failed = 0;

  const queue = prompts.slice();
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const name = `${String(p.index).padStart(4, '0')}_${p.gender}`;
      const file = path.join(outDir, `${name}.png`);
      try { await fs.access(file); done++; continue; } catch { /* 未生成 */ }
      try {
        const buf = await generateOne(key, args.model, p.text);
        await fs.writeFile(file, buf);
        meta.push({ file: `${name}.png`, ...p });
        done++;
        if (done % 10 === 0) console.log(`  ${done}/${prompts.length} 生成済み (失敗 ${failed})`);
      } catch (e) {
        failed++;
        console.log(`  [fail ${p.index}] ${e.message.slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  });
  await Promise.all(workers);

  await fs.writeFile(path.join(outDir, 'prompts.json'), JSON.stringify(meta, null, 1));
  console.log(`\n完了: ${done} 枚 → ${outDir}  (失敗 ${failed})`);
  console.log(`次: node tools/analyze.mjs --from ${args.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
