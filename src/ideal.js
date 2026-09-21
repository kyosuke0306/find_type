// 測った好みから「理想の顔」をその場で作る。
//
// 診断はプールから選ぶだけなので、その人の理想そのものが入っているとは限らない。
// ここでは実測した理想値をプロンプトに直して、生成器に作らせる。
//
// **鍵はこのファイルにも、リポジトリのどこにも持たない。**
// このアプリは静的サイトで、サーバーがない。鍵を同梱するとソースを見た誰もが
// 読み取れて、持ち主の残高を使えてしまう。ブラウザ側のパスワード確認は
// 鍵が手元にある前提の見せかけにしかならない。
// そこで、入力欄に鍵そのものを入れてもらう方式にしている。
// 鍵を知っている人だけが使えて、鍵は端末の外に出ない。
import { KEYS, FEATURE_BY_KEY } from './features.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-3.1-flash-image';

// 1枚あたりの表示価格。実費ではなく、気軽に押させないための目安。
export const PRICE_YEN = 300;

// プールの顔と同じ撮り方にそろえる。tools/generate.mjs の FRAMING と同じ内容。
const FRAMING = [
  'head and shoulders portrait photograph, square 1:1 composition',
  'the whole head and both shoulders visible, with clear empty space above the head and below the shoulders',
  'the head takes up about half of the image height, not filling the frame',
  'facing the camera directly, head straight, eyes looking at the camera',
  'neutral relaxed expression, mouth closed',
  'plain light grey seamless studio background',
  'soft even frontal lighting, no harsh shadows',
  'wearing a plain light grey crew-neck t-shirt',
  'sharp focus, photorealistic, 50mm lens, natural skin texture',
  'no glasses, no hat, no jewelry, natural everyday makeup, hair not covering the eyebrows',
].join(', ');

const VIBE = 'strikingly beautiful and very cute, as pretty as a popular idol or actress, '
  + 'photogenic delicate features, flawless clear skin';

// 項目ごとの言い回し（低い側 / 中間 / 高い側）。
// tools/generate.mjs の FILL_PHRASES と同じ語彙にそろえてある。
const PHRASES = {
  faceLength:  ['a round face', null, 'a slightly long slender face'],
  jawSharp:    ['a soft rounded jawline', null, 'a slim pointed chin'],
  eyeSize:     ['narrow elegant eyes', null, 'large round eyes'],
  eyeTilt:     ['slightly downturned outer eye corners', null, 'slightly upturned outer eye corners'],
  eyeDistance: ['eyes set slightly close together', null, 'eyes set slightly wide apart'],
  browEyeGap:  ['eyebrows sitting close to the eyes', null, 'eyebrows set a little high above the eyes'],
  browAngle:   ['softly downward-slanting eyebrows', null, 'slightly upward-angled eyebrows'],
  browArch:    ['straight eyebrows', null, 'gently arched eyebrows'],
  noseWidth:   ['a narrow slender nose', null, 'a slightly wide softly rounded nose'],
  mouthWidth:  ['a small delicate mouth', null, 'a slightly wide mouth'],
  lipThick:    ['slim delicate lips', null, 'full plump lips'],
  ageLook:     ['18 years old, a youthful girlish face', '21 years old', '25 years old, a composed grown-up face'],
  skinTone:    ['very fair porcelain skin', null, 'lightly tanned glowing skin'],
  hairColor:   ['jet black hair', 'dark brown hair', 'dyed light brown hair'],
};

/**
 * 診断結果からプロンプトを作る。
 * 重視している項目だけを並べる。全部入れると指示が多すぎて生成器が取りこぼす。
 */
export function buildIdealPrompt(r, max = 6) {
  const order = KEYS.map((_, i) => i)
    .filter((i) => PHRASES[KEYS[i]])
    .sort((a, b) => r.importance[b] - r.importance[a])
    .slice(0, max);
  const parts = [];
  for (const i of order) {
    const k = KEYS[i];
    const m = r.m[i];
    const p = PHRASES[k];
    const word = m > 0.62 ? p[2] : m < 0.38 ? p[0] : p[1];
    if (word) parts.push(word);
  }
  // 髪の長さは測っていないので、プールにそろえてロングにする。
  parts.push('long straight hair past the chest');
  return `A ${FRAMING}. A ${VIBE} Japanese woman, ${parts.join(', ')}.`;
}

/** 結果から、その人向けの説明文（日本語）を作る。画面に出す用。 */
export function describeIdeal(r, max = 3) {
  const order = KEYS.map((_, i) => i)
    .sort((a, b) => r.importance[b] - r.importance[a])
    .slice(0, max);
  return order.map((i) => {
    const f = FEATURE_BY_KEY[KEYS[i]];
    const m = r.m[i];
    return m > 0.62 ? f.highTag : m < 0.38 ? f.lowTag : `中間の${f.name}`;
  });
}

class Retryable extends Error {}

async function once(key, prompt) {
  const res = await fetch(`${API}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    }),
  });
  const json = await res.json().catch(() => ({}));

  if (res.status === 401 || res.status === 403) {
    throw new Error('パスワードが違います。');
  }
  // 混雑・一時的な失敗は作り直す。上限に当たった場合は待っても無駄なので止める。
  if (res.status === 429) {
    const msg = json?.error?.message ?? '';
    if (/limit:\s*0\b|spending cap|spend cap/i.test(msg)) {
      throw new Error('APIの上限に達しています。しばらく待つか、上限を上げてください。');
    }
    throw new Retryable('混雑しています');
  }
  if (!res.ok) throw new Retryable(`HTTP ${res.status}`);

  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  // 画像が返らないことがある（安全フィルタなど）。作り直せば通ることが多い。
  if (!img) throw new Retryable('画像が返りませんでした');
  return `data:${img.inlineData.mimeType ?? 'image/png'};base64,${img.inlineData.data}`;
}

/**
 * 理想の顔を1枚作る。失敗したら自動で作り直す。
 * onTry(n) で何回目かを知らせる。
 */
export async function generateIdeal(key, prompt, { tries = 4, onTry = null } = {}) {
  let last = null;
  for (let n = 1; n <= tries; n++) {
    if (onTry) onTry(n);
    try {
      return await once(key, prompt);
    } catch (e) {
      // 作り直しても意味のない失敗（鍵違い・上限）はそのまま返す
      if (!(e instanceof Retryable)) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 1200 * n));
    }
  }
  throw new Error(`${tries}回試しましたが作れませんでした（${last?.message ?? ''}）。`);
}
