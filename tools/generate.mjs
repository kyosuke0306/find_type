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
import { FEATURES, KEYS, normalizePool } from '../src/features.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

const AXES = {
  faceShape: ['round face', 'oval face', 'long narrow face', 'square jawline', 'heart-shaped face with pointed chin'],
  eyes: ['large round eyes', 'almond-shaped eyes', 'narrow monolid eyes', 'upturned eyes', 'droopy downturned eyes', 'wide-set eyes', 'close-set deep-set eyes'],
  brows: ['thick straight eyebrows', 'thin arched eyebrows', 'softly curved eyebrows', 'bold angular eyebrows'],
  nose: ['small button nose', 'straight narrow nose', 'wide rounded nose', 'high-bridged nose'],
  lips: ['thin lips', 'full plump lips', 'medium lips with defined cupid bow'],
  hair: ['a very short pixie cut', 'short hair above the ears', 'chin-length bob', 'shoulder-length hair', 'long hair past the chest'],
  hairColor: ['jet black hair', 'dark brown hair', 'light brown hair', 'ash grey hair', 'blonde hair'],
  skin: ['fair pale skin', 'light skin', 'medium olive skin', 'tan brown skin', 'deep brown skin'],
  // 18〜25歳。顔を好みで採点するアプリなので、未成年にあたる年齢は生成しない。
  // 「顔立ちの印象」の軸を測るために幅を持たせつつ、
  // 大学生にあたる 18〜22歳を厚めにしている（同じ年齢を複数回入れて重みを付ける）。
  age: ['18 years old', '19 years old', '19 years old', '20 years old', '20 years old',
        '21 years old', '21 years old', '22 years old', '24 years old', '25 years old'],
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
  // 既定。アイドルや女優くらいのかわいさを狙う。
  // 「かわいい人の中での好み」を診断するアプリなので、ここが基準線になる。
  idol: 'strikingly beautiful and very cute, as pretty as a popular idol or actress, photogenic delicate features, flawless clear skin',
  student: 'cute and pretty college student, youthful girlish and fresh-faced, soft gentle features, clear healthy skin, bare natural look',
  cute: 'cute and pretty, youthful and fresh-faced, clear healthy skin',
  neutral: '',
};

// アイドル狙いのときに差し替える属性。
// 診断は「かわいい人の中でどのタイプが好みか」を当てるものなので、
// 軸のばらつきは残したまま、どれを選んでもかわいく見える言い回しにそろえる。
// 例えば目の軸は「細い/大きい」の幅を保ちつつ、両端とも魅力的な表現にしている。
// 冠詞は本文側で付けるので、ここには書かない。
const IDOL_AXES = {
  faceShape: ['round baby face', 'oval face', 'slim long face', 'heart-shaped face with a pointed chin', 'small V-line face'],
  eyes: ['large round double-eyelid eyes', 'almond-shaped double-eyelid eyes', 'slightly upturned cat-like eyes', 'gently downturned puppy-like eyes', 'narrow elegant monolid eyes', 'wide-set doll-like eyes'],
  brows: ['soft straight eyebrows', 'gently arched eyebrows', 'thin elegant eyebrows', 'natural slightly thick eyebrows'],
  nose: ['small delicate nose', 'straight slender nose', 'slightly upturned button nose', 'high-bridged refined nose'],
  lips: ['small thin lips', 'full plump lips', 'medium lips with a defined cupid bow'],
  // 髪の明るさは既に明るい側に偏っているので、金髪は外す
  hairColor: ['jet black hair', 'dark brown hair', 'dyed light brown hair', 'dyed ash brown hair'],
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
  // 化粧は許可する。ただし眉は実測するので前髪で隠さない。
  'no glasses, no hat, no jewelry, natural everyday makeup, hair not covering the eyebrows',
  // 生成器は放っておくと同じ顔を髪型だけ変えて使い回す。毎回別人にさせる。
  'a completely different individual from the previous images, distinct facial structure',
];
const FRAMING = FRAMING_PARTS.join(', ');

// 弱い項目を狙って埋めるときに使う、項目ごとの端の言い回し。
// 診断項目とプロンプトの語を1対1で結びつけておく。
//
// 「very」「strongly」のような強調は付けない。
// 強調すると顔が崩れて、かわいい人を見るという目的から外れる。
// 実測値はプール内での相対順位なので、控えめな差でも軸は動く。
const FILL_PHRASES = {
  faceLength:  ['a round face', 'a slightly long slender face'],
  jawSharp:    ['a soft rounded jawline', 'a slim pointed chin'],
  eyeSize:     ['narrow elegant eyes', 'large round eyes'],
  eyeTilt:     ['slightly downturned outer eye corners', 'slightly upturned outer eye corners'],
  eyeDistance: ['eyes set slightly close together', 'eyes set slightly wide apart'],
  browEyeGap:  ['eyebrows sitting close to the eyes', 'eyebrows set a little high above the eyes'],
  browAngle:   ['softly downward-slanting eyebrows', 'slightly upward-angled eyebrows'],
  browArch:    ['straight eyebrows', 'gently arched eyebrows'],
  noseWidth:   ['a narrow slender nose', 'a slightly wide softly rounded nose'],
  mouthWidth:  ['a small delicate mouth', 'a slightly wide mouth'],
  lipThick:    ['slim delicate lips', 'full plump lips'],
  ageLook:     ['18 years old, a youthful girlish face', '25 years old, a composed grown-up face'],
  skinTone:    ['very fair porcelain skin', 'lightly tanned glowing skin'],
  hairColor:   ['jet black hair', 'dyed light brown hair'],
  hairLength:  ['a short pixie cut', 'very long hair past the chest'],
};

// 測定ノイズ（tools/noise-check.mjs の実測値。coverage.mjs と同じ）。
// 「実測の幅 ÷ ノイズ2つ分」で、その項目が何段階に見分けられるかが出る。
// 段階が少ない項目は、人が見ても差が分からない＝選ぶ手がかりにならない。
const NOISE = { faceLength:8.43e-4, jawSharp:4.21e-4, eyeSize:2.28e-4, eyeTilt:2.37e-4,
  eyeDistance:3.35e-4, browEyeGap:1.49e-3, browAngle:1.02e-3, browArch:3.27e-4,
  noseWidth:3.42e-4, mouthWidth:1.44e-3, lipThick:6.21e-4, skinTone:4.83e-1,
  hairColor:5.02e-1, hairLength:8.14e-3, ageLook:2.42e-1 };
const LEVELS_OK = 18;   // これを下回る項目は幅が足りない

// 1項目だけを狙うときに使う、はっきりした言い回し。
// 端を何本も重ねると顔が崩れるが、1本だけなら崩れない。
const STRONG_PHRASES = {
  faceLength:  ['a distinctly round wide face', 'a distinctly long slender face'],
  jawSharp:    ['a very soft rounded jawline with a wide chin', 'a very sharp narrow V-line chin'],
  eyeSize:     ['notably narrow slim eyes', 'notably large round eyes'],
  eyeTilt:     ['clearly downturned outer eye corners', 'clearly upturned outer eye corners'],
  eyeDistance: ['eyes set clearly close together', 'eyes set clearly wide apart'],
  browEyeGap:  ['eyebrows sitting right above the eyes', 'eyebrows set clearly high above the eyes'],
  browAngle:   ['clearly downward-slanting eyebrows', 'clearly upward-angled eyebrows'],
  browArch:    ['completely straight flat eyebrows', 'clearly arched eyebrows'],
  noseWidth:   ['a clearly narrow slim nose', 'a clearly wide rounded nose'],
  mouthWidth:  ['a clearly small mouth', 'a clearly wide mouth'],
  lipThick:    ['clearly thin lips', 'clearly full plump lips'],
  ageLook:     ['18 years old, a very youthful girlish face', '25 years old, a composed grown-up face'],
  skinTone:    ['very fair porcelain skin', 'clearly tanned skin'],
  hairColor:   ['jet black hair', 'brightly dyed light brown hair'],
  hairLength:  ['a very short pixie cut', 'very long hair past the chest'],
};

/**
 * 既存のプールを調べ、足りていない組み合わせを「目標」として並べる。
 * 精度が上がらない原因は主に2つある。
 *   1. その項目の端にあたる顔が少ない（片寄り）
 *   2. 2つの項目が相関していて切り分けられない
 * 1 には足りない端を、2 には逆の組み合わせを作らせる。
 */
function planFill(faces) {
  const pool = normalizePool(faces);
  const targets = [];

  // 0. 幅そのものが足りない項目。
  // 人の目に差が見えないと選ぶ手がかりにならず、その項目は診断できない。
  // 両端をはっきり作らせるのが最優先。
  for (const [i, k] of KEYS.entries()) {
    const xs = faces.map((f) => f.raw[k]).filter(Number.isFinite);
    if (xs.length < 5) continue;
    const levels = (Math.max(...xs) - Math.min(...xs)) / (NOISE[k] * 2);
    if (levels >= LEVELS_OK) continue;
    for (const end of [0, 1]) {
      targets.push({
        why: `${FEATURES[i].name}の幅が狭い（${levels.toFixed(0)}段階しかなく差が見えない）`,
        set: { [k]: end }, strong: true,
        harm: 2 + (LEVELS_OK - levels) / LEVELS_OK,
      });
    }
  }

  // 1. 端が少ない項目
  for (const [i, k] of KEYS.entries()) {
    const xs = faces.map((f) => f.raw[k]).filter(Number.isFinite).sort((a, b) => a - b);
    if (xs.length < 5) continue;
    const lo = xs[0], hi = xs[xs.length - 1], range = hi - lo;
    const t1 = lo + range / 3, t2 = lo + range * 2 / 3;
    const low = xs.filter((x) => x < t1).length, high = xs.filter((x) => x >= t2).length;
    const even = xs.length / 3;
    // 深刻さ = その端がどれだけ空いているか（0 なら1枚もない）
    if (low < even * 0.6) targets.push({ why: `${FEATURES[i].name}の「${FEATURES[i].lowTag}」側が少ない`, set: { [k]: 0 }, harm: 1 - low / even });
    if (high < even * 0.6) targets.push({ why: `${FEATURES[i].name}の「${FEATURES[i].highTag}」側が少ない`, set: { [k]: 1 }, harm: 1 - high / even });
  }

  // 2. 相関している組
  const corr = [];
  for (let a = 0; a < KEYS.length; a++) for (let b = a + 1; b < KEYS.length; b++) {
    const xs = pool.map((f) => f.v[KEYS[a]]), ys = pool.map((f) => f.v[KEYS[b]]);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    const r = num / Math.sqrt(dx * dy);
    if (Math.abs(r) > 0.5) corr.push({ a: KEYS[a], b: KEYS[b], ia: a, ib: b, r });
  }
  corr.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  for (const c of corr.slice(0, 6)) {
    // 相関を崩すには、これまで出ていない側の組み合わせを作る
    const [p, q] = c.r > 0 ? [[0, 1], [1, 0]] : [[0, 0], [1, 1]];
    for (const [va, vb] of [p, q]) {
      targets.push({
        why: `${FEATURES[c.ia].name}と${FEATURES[c.ib].name}が相関(${c.r.toFixed(2)})していて切り分けられない`,
        set: { [c.a]: va, [c.b]: vb },
        // 相関は2項目が丸ごと1本に潰れるので、端の不足より重く見る
        harm: Math.abs(c.r) + 0.35,
      });
    }
  }
  // 全部は作れないことが多いので、困っている順に並べる。
  // 上から順に作れば、途中でやめても効きの大きいものが埋まる。
  targets.sort((x, y) => y.harm - x.harm);
  return targets;
}

/** 目標を満たすプロンプトを作る。指定のない項目は適当に散らす。 */
// 同じ部位を指す項目。狙い以外でここから2つ以上入れると
// 「丸顔なのにシャープなあご」のような矛盾した指示になる。
const PART_OF = {
  faceLength: 'shape', jawSharp: 'shape',
  eyeSize: 'eyes', eyeTilt: 'eyes', eyeDistance: 'eyes',
  browEyeGap: 'brows', browAngle: 'brows', browArch: 'brows',
  noseWidth: 'nose', mouthWidth: 'mouth', lipThick: 'mouth',
  ageLook: 'age', skinTone: 'skin', hairColor: 'hair', hairLength: 'hair',
};
// 狙い以外に足す指定の数。
// 増やすと生成器が指示を取りこぼし、かわいさの指定も薄まる。
const EXTRA_SPECS = 2;

function buildFillPrompts(targets, n, opts) {
  const rand = mulberry(opts.seed);
  const vibe = VIBE[opts.vibe] ?? VIBE.idol;
  const axes = opts.vibe === 'idol' ? { ...AXES, ...EAST_ASIAN_AXES, ...IDOL_AXES } : { ...AXES, ...EAST_ASIAN_AXES };
  const out = [];
  for (let i = 0; i < n; i++) {
    const tgt = targets[i % targets.length];
    const set = { ...tgt.set };
    const used = new Set(Object.keys(set).map((k) => PART_OF[k]));

    // 狙いの項目だけを端に振る。
    // 以前はここでも端の言い回しを足していたが、端を何本も重ねると
    // 顔が崩れる。狙い以外は、どれを引いてもかわいく見える語彙から選ぶ。
    // 狙いが1項目だけのときは、はっきりした言い回しを使う。
    // 端を1本だけ振るぶんには顔は崩れない。
    const book = tgt.strong ? STRONG_PHRASES : FILL_PHRASES;
    const phrases = KEYS.filter((k) => k !== 'ageLook' && k in set).map((k) => book[k][set[k]]);
    const extras = [
      ['eyes', 'eyes'], ['brows', 'brows'], ['shape', 'faceShape'],
      ['nose', 'nose'], ['mouth', 'lips'], ['hair', 'hair'],
    ].filter(([part]) => !used.has(part)).sort(() => rand() - 0.5).slice(0, EXTRA_SPECS);
    // 属性の語には冠詞が付いていないので、単独で並べるときは補う
    const an = (w) => (/^(a|an|the) /.test(w) ? w : `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`);
    for (const [part, axis] of extras) {
      const list = axes[axis];
      const w = list[Math.floor(rand() * list.length)];
      phrases.push(['shape', 'nose'].includes(part) ? an(w) : w);
    }

    const age = set.ageLook !== undefined ? book.ageLook[set.ageLook] : AXES.age[Math.floor(rand() * AXES.age.length)];
    // 条件を並べると美しさの指定が薄まるので、最後にもう一度念を押す
    const variation = `Japanese woman, ${age}, ${phrases.join(', ')}, still a strikingly pretty and cute face`;
    out.push({
      index: i, gender: 'woman', why: tgt.why,
      variation,
      text: `A ${FRAMING}. A ${vibe} ${variation}.`,
    });
  }
  return out;
}

function parseArgs(argv) {
  const a = { count: 160, out: '.cache/raw', model: 'gemini-3.1-flash-image', imageSize: '0.5K', ethnicity: 'japanese', vibe: 'idol', fill: null, femaleRatio: 0.5, dryRun: false, list: false, concurrency: 3, seed: 12345 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--count') a.count = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--image-size') a.imageSize = argv[++i];
    else if (k === '--ethnicity') a.ethnicity = argv[++i];
    else if (k === '--vibe') a.vibe = argv[++i];
    else if (k === '--fill') a.fill = argv[++i] ?? 'data/faces.json';
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
  let axes = ['japanese', 'eastasian'].includes(opts.ethnicity) ? { ...AXES, ...EAST_ASIAN_AXES } : AXES;
  if (opts.vibe === 'idol') axes = { ...axes, ...IDOL_AXES };
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
    const vibe = VIBE[opts.vibe] ?? VIBE.idol;
    const who2 = vibe ? `${vibe} ${who}` : who;
    const an = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
    const text = `A ${FRAMING}. A ${who2} ${gender}, ${pick.age}, with ${an(pick.faceShape)}, ${pick.eyes}, ${pick.brows}, ${an(pick.nose)}, ${pick.lips}, ${hair}, ${pick.hairColor}, ${pick.skin}.`;
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

  let prompts, fillNote = '';
  if (args.fill) {
    const faces = JSON.parse(await fs.readFile(path.resolve(args.fill), 'utf8')).faces;
    const targets = planFill(faces);
    if (!targets.length) { console.log('補うべき弱点は見つかりませんでした。'); return; }
    prompts = buildFillPrompts(targets, args.count, args);
    fillNote = `既存 ${faces.length} 枚の弱点を補う指定です。`;
    console.log(`弱点 ${targets.length} 件に対して ${args.count} 件のプロンプトを作ります:`);
    for (const t of [...new Set(targets.map((t) => t.why))]) console.log(`  - ${t}`);
    console.log();
  } else {
    prompts = buildPrompts(args.count, args);
  }
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
      ...(fillNote ? ['#', `# ${fillNote}`] : []),
      '#',
      '# スマホなど、長文を毎回貼り付けるのが大変な場合はこちらを使ってください。',
      '# 共通条件を最初に1回送り、あとは番号付きの行を1つずつ送るだけです。',
      '#',
      '# 同じ人物ばかり出てくるときは:',
      '#   - 5〜6枚ごとに新しい会話を始めてください（前の顔に引きずられなくなります）',
      '#   - それでも似る場合は「前の人とは血縁関係のない別人にしてください」と付け足してください',
      '#',
      ...CHECKS,
      '',
      '===== 最初に1回だけ送る =====',
      '',
      `これから人物のポートレート写真を${prompts.length}枚つくります。毎回かならず次の条件を守ってください。`,
      '',
      FRAMING_PARTS.map((x) => `- ${x}`).join('\n'),
      ...(VIBE[args.vibe] ?? VIBE.idol ? [`- ${VIBE[args.vibe] ?? VIBE.idol}`] : []),
      '',
      'このあと人物の特徴を1行ずつ送ります。そのつど条件を満たす写真を1枚だけ生成してください。',
      '説明文は不要です。',
      '',
      '★ もっとも重要: 毎回かならず別人にしてください。',
      '  前に出した顔の髪型や髪色だけを変えて使い回さないでください。',
      '  骨格・目・鼻・口が違う、血縁関係のない別人にしてください。',
      '',
      '===== 以降、1行ずつ送る =====',
      '',
      prompts.map((p) => (p.why ? `# ${p.why}\n` : '')
        + `${p.index + 1}) A NEW person, #${p.index + 1}, never seen before — ${p.variation}`).join('\n\n'),
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
