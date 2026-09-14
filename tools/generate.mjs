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
  // 10代後半から30代まで。顔を好みで採点するアプリなので、
  // 未成年にあたる年齢は生成しない（10代は18・19歳のみ）。
  // 「顔立ちの印象」の軸を測るために、各年代に散らしている。
  age: ['18 years old', '19 years old', '23 years old', '27 years old', '32 years old', '37 years old'],
};

const ETHNICITY = {
  japanese: ['Japanese'],
  eastasian: ['Japanese', 'Korean', 'Chinese'],
  mixed: ['Japanese', 'Korean', 'Chinese', 'Japanese', 'Southeast Asian', 'White European', 'Black', 'Latin American', 'Middle Eastern', 'mixed-race'],
  global: ['White European', 'Black', 'Latin American', 'South Asian', 'Middle Eastern', 'East Asian', 'Southeast Asian'],
};

// 日本人・東アジア系に限定するときは、肌と髪の選択肢を現実的な範囲に差し替える。
// 「deep brown skin の日本人」のような矛盾した指定を避けるため。
// 生成する人物の雰囲気。--vibe で切り替える。
const VIBE = {
  cute: 'cute and pretty, youthful and fresh-faced, clear healthy skin',
  neutral: '',
};

const EAST_ASIAN_AXES = {
  skin: ['very fair porcelain skin', 'fair skin', 'light skin with warm undertone', 'medium skin tone', 'lightly tanned skin'],
  hairColor: ['jet black hair', 'dark brown hair', 'dyed light brown hair', 'dyed ash brown hair', 'dyed bleached blonde hair'],
};

// 全カット共通の構図指定。ここがぶれると肌色・髪の長さの実測が狂う。
const FRAMING_PARTS = [
  'head and shoulders portrait photograph, square 1:1 composition',
  'the whole head and both shoulders visible, with clear empty space above the head and below the shoulders',
  'the head takes up about half of the image height, not filling the frame',
  'facing the camera directly, head straight, eyes looking at the camera',
  'neutral relaxed expression, mouth closed',
  'plain light grey seamless studio background',
  'soft even frontal lighting, no harsh shadows',
  'wearing a plain light grey crew-neck t-shirt',
  'sharp focus, photorealistic, 50mm lens, natural skin texture',
  'no glasses, no hat, no jewelry, no visible makeup product, hair not covering the eyebrows',
];
const FRAMING = FRAMING_PARTS.join(', ');

function parseArgs(argv) {
  const a = { count: 160, out: '.cache/raw', model: 'gemini-3.1-flash-image', imageSize: '0.5K', ethnicity: 'japanese', vibe: 'cute', femaleRatio: 0.5, dryRun: false, list: false, concurrency: 3, seed: 12345 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--count') a.count = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--image-size') a.imageSize = argv[++i];
    else if (k === '--ethnicity') a.ethnicity = argv[++i];
    else if (k === '--vibe') a.vibe = argv[++i];
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
  const eth = ETHNICITY[opts.ethnicity] ?? ETHNICITY.japanese;
  const axes = ['japanese', 'eastasian'].includes(opts.ethnicity) ? { ...AXES, ...EAST_ASIAN_AXES } : AXES;
  const bags = Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, makeBag(v, rand)]));
  const ethBag = makeBag(eth, rand);
  const out = [];
  for (let i = 0; i < n; i++) {
    const gender = i < Math.round(n * opts.femaleRatio) ? 'woman' : 'man';
    const pick = Object.fromEntries(Object.keys(axes).map((k) => [k, bags[k]()]));
    const who = ethBag();
    const hair = gender === 'man' && /past the chest|shoulder-length/.test(pick.hair)
      ? (rand() < 0.7 ? 'short hair above the ears' : pick.hair) : pick.hair;
    // variation = 顔ごとに変わる部分だけ。チャット形式ではこれだけを送れば足りる。
    const variation = `${who} ${gender}, ${pick.age}, ${pick.faceShape}, ${pick.eyes}, ${pick.brows}, ${pick.nose}, ${pick.lips}, ${hair}, ${pick.hairColor}, ${pick.skin}`;
    const vibe = VIBE[opts.vibe] ?? VIBE.cute;
    const who2 = vibe ? `${vibe} ${who}` : who;
    const text = `A ${FRAMING}. A ${who2} ${gender}, ${pick.age}, with a ${pick.faceShape}, ${pick.eyes}, ${pick.brows}, a ${pick.nose}, ${pick.lips}, ${hair}, ${pick.hairColor}, ${pick.skin}.`;
    out.push({ index: i, gender, text, variation, attrs: { ...pick, hair, ethnicity: who } });
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

/** 課金が無効なプロジェクトでは画像モデルの上限が 0 になるため、それを見分ける */
class QuotaZeroError extends Error {}

/** Gemini image (generateContent) と Imagen (predict) の両方に対応する */
async function generateOne(key, model, prompt, imageSize) {
  const isImagen = /imagen/i.test(model);
  const url = isImagen ? `${API}/models/${model}:predict?key=${key}` : `${API}/models/${model}:generateContent?key=${key}`;
  // 解像度は料金に直結する（低いほど安い）。このアプリは最終的に縮小するので小さくてよい。
  // ただしモデルごとに受け付ける値が違うため、拒否されたら指定を外して再試行する。
  const imageConfig = { aspectRatio: '1:1', ...(imageSize ? { imageSize } : {}) };
  const body = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1', personGeneration: 'allow_adult' } }
    : { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig } };

  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();

  if (res.status === 429) {
    const msg = json?.error?.message ?? '';
    // 「limit: 0」は一時的な混雑ではなく、そのモデルが使えないという意味なので待っても無駄
    if (/limit:\s*0\b/.test(msg)) {
      throw new QuotaZeroError(
        `モデル ${model} は現在のプロジェクトで利用できません（無料枠の上限が 0 です）。\n` +
        '  Gemini の画像生成には課金の有効化が必要です: https://aistudio.google.com/ の "Set up Billing"\n' +
        '  課金を有効にしたくない場合は、別のツールで画像を作って tools/analyze.mjs に渡してください。');
    }
    const wait = Number(/retry in ([\d.]+)s/i.exec(msg)?.[1] ?? 20);
    const e = new Error(`レート制限。${wait.toFixed(0)}秒待ちます`);
    e.retryAfter = wait;
    throw e;
  }
  if (res.status === 400 && imageSize && /image[_ ]?size/i.test(json?.error?.message ?? '')) {
    console.log(`  imageSize=${imageSize} は ${model} では使えないため、指定なしで続行します`);
    return generateOne(key, model, prompt, null);
  }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);

  const b64 = isImagen
    ? json.predictions?.[0]?.bytesBase64Encoded
    : json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) {
    const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? '不明';
    throw new Error(`画像が返りませんでした (${reason})`);
  }
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
    // API を使わず手で生成する場合に備え、全プロンプトをファイルに書き出す
    const outDir = path.resolve(args.out);
    await fs.mkdir(outDir, { recursive: true });
    const CHECKS = [
      '# 生成された画像を見るときの確認点:',
      '#   - 正面を向いているか（大きく傾いていると計測精度が落ちます）',
      '#   - 背景が無地か（雑多だと「髪の長さ」が計測できません）',
      '#   - 眉が前髪で隠れていないか',
      '# 条件から外れたものは保存しなくて構いません。足りない分は後から追加できます。',
      '#',
      '# 重要: スクリーンショットではなく画像そのものを保存してください。',
      '#       画面の余白やUIが写り込むと背景が無地でなくなり、髪の長さが測れません。',
    ];

    // (1) 1件ずつ完結したプロンプト（API や 1回ごとの貼り付け用）
    const listPath = path.join(outDir, 'prompts.txt');
    await fs.writeFile(listPath, [
      `# 顔の好み診断 用プロンプト（${prompts.length}件）`,
      '#',
      '# 画像生成モデルに1件ずつ貼り付け、',
      `# 生成された画像を ${args.out}/ に保存してください（ファイル名は自由）。`,
      '#',
      ...CHECKS,
      '#',
      `# 全部そろったら:  npm run analyze -- --from ${args.out} --debug .cache/debug`,
      '',
      prompts.map((p) => `--- ${p.index + 1} / ${prompts.length}  (${p.gender})\n${p.text}\n`).join('\n'),
    ].join('\n'));

    // (2) チャット形式。共通条件を最初に1回送り、以降は1行ずつ。
    //     スマホでは長文を毎回貼り付けるのが現実的でないため。
    const chatPath = path.join(outDir, 'prompts-chat.txt');
    await fs.writeFile(chatPath, [
      `# 顔の好み診断 用プロンプト（チャット形式 / ${prompts.length}件）`,
      '#',
      '# スマホなど、長文を毎回貼り付けるのが大変な場合はこちらを使ってください。',
      '# 共通条件を最初に1回送り、あとは番号付きの行を1つずつ送るだけです。',
      '#',
      ...CHECKS,
      '',
      '===== 最初に1回だけ送る =====',
      '',
      `これから人物のポートレート写真を${prompts.length}枚つくります。毎回かならず次の条件を守ってください。`,
      '',
      FRAMING_PARTS.map((x) => `- ${x}`).join('\n'),
      ...(VIBE[args.vibe] ?? VIBE.cute ? [`- ${VIBE[args.vibe] ?? VIBE.cute}`] : []),
      '',
      'このあと人物の特徴を1行ずつ送ります。そのつど条件を満たす写真を1枚だけ生成してください。',
      '説明文は不要です。',
      '',
      '===== 以降、1行ずつ送る =====',
      '',
      prompts.map((p) => `${p.index + 1}) ${p.variation}`).join('\n'),
      '',
      '===== 貼り付け回数を減らしたい場合 =====',
      '',
      '上の共通条件に加えて「4人を2x2に並べた1枚の画像にしてください」と指示すると、',
      '1回で4人分つくれます。その場合は解析時に --multi を付けてください。',
      '',
      `  npm run analyze -- --from ${args.out} --multi --debug .cache/debug`,
      '',
      'ただし1人あたりの解像度は下がります。',
      '',
    ].join('\n'));

    prompts.slice(0, 3).forEach((p) => console.log(`[${p.index + 1}] ${p.text}\n`));
    console.log(`全 ${prompts.length} 件を書き出しました（--dry-run のため生成はしていません）`);
    console.log(`  1件ずつ貼る用: ${path.relative(process.cwd(), listPath)}`);
    console.log(`  スマホ向け  : ${path.relative(process.cwd(), chatPath)}`);
    return;
  }
  if (!key) { console.error('GEMINI_API_KEY を設定してください（https://aistudio.google.com/apikey）'); process.exit(1); }

  const outDir = path.resolve(args.out);
  await fs.mkdir(outDir, { recursive: true });
  const meta = [];
  let done = 0, failed = 0;

  const queue = prompts.slice();
  let fatal = null;
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
    while (queue.length && !fatal) {
      const p = queue.shift();
      const name = `${String(p.index).padStart(4, '0')}_${p.gender}`;
      const file = path.join(outDir, `${name}.png`);
      try { await fs.access(file); done++; continue; } catch { /* 未生成 */ }

      // レート制限のときだけ待って数回やり直す
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const buf = await generateOne(key, args.model, p.text, args.imageSize);
          await fs.writeFile(file, buf);
          meta.push({ file: `${name}.png`, ...p });
          done++;
          if (done % 10 === 0) console.log(`  ${done}/${prompts.length} 生成済み (失敗 ${failed})`);
          break;
        } catch (e) {
          if (e instanceof QuotaZeroError) { fatal = e; break; }
          if (e.retryAfter && attempt < 3) {
            await new Promise((r) => setTimeout(r, (e.retryAfter + 1) * 1000));
            continue;
          }
          failed++;
          console.log(`  [fail ${p.index}] ${e.message.slice(0, 200)}`);
          break;
        }
      }
    }
  });
  await Promise.all(workers);

  if (meta.length) await fs.writeFile(path.join(outDir, 'prompts.json'), JSON.stringify(meta, null, 1));
  if (fatal) {
    console.error(`\n中断しました。\n${fatal.message}`);
    console.error(`\n利用できるモデルの確認: node tools/generate.mjs --list-models`);
    process.exit(1);
  }
  console.log(`\n完了: ${done} 枚 → ${outDir}  (失敗 ${failed})`);
  console.log(`次: node tools/analyze.mjs --from ${args.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
