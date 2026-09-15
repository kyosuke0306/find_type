// 顔の特徴軸の定義と、実測値(raw)をプール内での相対値(0..1)へ正規化する処理。
//
// raw 値は tools/analyze.mjs が写真から実測したもの（68点ランドマークの幾何量と画素統計）。
// 絶対値のままでは「大きい/小さい」の基準が決まらないため、
// プール全体での順位（パーセンタイル）に変換して 0..1 の相対尺度にそろえる。

export const FEATURES = [
  { key: 'faceLength',  name: '輪郭の縦横比', low: '丸顔',       high: '面長',         lowTag: '丸顔',       highTag: '面長' },
  { key: 'jawSharp',    name: 'あごのライン', low: '丸いあご',   high: 'シャープなあご', lowTag: 'ふんわり輪郭', highTag: 'シャープ輪郭' },
  { key: 'eyeSize',     name: '目の大きさ',   low: '切れ長の目', high: 'ぱっちりした目', lowTag: '切れ長',     highTag: 'ぱっちり目' },
  { key: 'eyeTilt',     name: '目尻の角度',   low: 'タレ目',     high: 'ツリ目',       lowTag: 'タレ目',     highTag: 'ツリ目' },
  { key: 'eyeDistance', name: '目の間隔',     low: '求心顔（目が近い）', high: '遠心顔（目が離れ気味）', lowTag: '求心顔', highTag: '遠心顔' },
  { key: 'browEyeGap',  name: '眉と目の距離', low: '彫りが深い（眉と目が近い）', high: '眉と目が離れている', lowTag: '彫り深め', highTag: '離れ眉' },
  { key: 'browAngle',   name: '眉の角度',     low: '下がり眉',   high: '上がり眉',     lowTag: '下がり眉',   highTag: '上がり眉' },
  { key: 'browArch',    name: '眉の形',       low: '平行眉',     high: 'アーチ眉',     lowTag: '平行眉',     highTag: 'アーチ眉' },
  { key: 'noseWidth',   name: '小鼻の広さ',   low: 'シュッとした鼻', high: '小鼻がしっかりした鼻', lowTag: '細い鼻', highTag: 'しっかり鼻' },
  { key: 'mouthWidth',  name: '口の大きさ',   low: '小さめの口', high: '大きめの口',   lowTag: 'おちょぼ口', highTag: '大きな口' },
  { key: 'lipThick',    name: '唇の厚さ',     low: '薄い唇',     high: 'ぽってりした唇', lowTag: '薄い唇',   highTag: 'ぽってり唇' },
  { key: 'ageLook',     name: '顔立ちの印象', low: '童顔',       high: '大人っぽい顔', lowTag: '童顔',       highTag: '大人顔' },
  { key: 'skinTone',    name: '肌の明るさ',   low: '色白',       high: '小麦肌',       lowTag: '色白',       highTag: '小麦肌' },
  { key: 'hairColor',   name: '髪の明るさ',   low: '黒髪',       high: '明るい髪',     lowTag: '黒髪',       highTag: '明るい髪' },
  { key: 'hairLength',  name: '髪の長さ',     low: 'ショート',   high: 'ロング',       lowTag: 'ショート',   highTag: 'ロング' },
];

export const KEYS = FEATURES.map((f) => f.key);

// このアプリで知りたいのは顔のパーツの好み。
// 髪と肌は「顔」ではないので、結果では分けて扱う。
export const LOOK_KEYS = ['skinTone', 'hairColor', 'hairLength'];
export const FACE_KEYS = KEYS.filter((k) => !LOOK_KEYS.includes(k));
export const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

// 実測のばらつき（tools/noise-check.mjs で測った値）。
// 同じ顔を少しずつ違う解像度で解析したときに値がどれだけ動くか。
const NOISE = { faceLength:1.55e-3, jawSharp:9.68e-4, eyeSize:5.43e-4, eyeTilt:4.84e-4,
  eyeDistance:5.24e-4, browEyeGap:2.31e-3, browAngle:2.18e-3, browArch:7.07e-4,
  noseWidth:7.47e-4, mouthWidth:3.34e-3, lipThick:1.50e-3, skinTone:7.46e-1,
  hairColor:1.59, hairLength:4.98e-3, ageLook:5.17e-1 };

// 「プール内の実測の幅 ÷ ノイズ2つ分」が何段階に見分けられるか。
// これを下回る項目は、顔どうしの差が小さすぎて人の目にも見えない。
// 正規化すると順位に引き伸ばされて大差に見えるが、中身は誤差でしかない。
const MIN_LEVELS = 15;

/**
 * 診断結果として言い切ってよい項目を返す。
 * 幅が足りない項目は、当たっているように見えても根拠がない。
 */
export function measurableKeys(faces) {
  const ok = new Set();
  for (const k of KEYS) {
    const xs = faces.map((f) => f.raw?.[k]).filter(Number.isFinite);
    if (xs.length < 5) continue;
    if ((Math.max(...xs) - Math.min(...xs)) / (NOISE[k] * 2) >= MIN_LEVELS) ok.add(k);
  }
  return ok;
}

/**
 * 「きれい系 ⇔ かわいい系」の軸。
 * w    … その特徴がこの軸をどれだけ決めるか
 * sign … +1 なら値が大きいほど「かわいい系」、-1 なら「きれい系」
 * 鼻の広さ・肌・髪はどちらの系統にも寄らないので入れていない。
 */
export const CUTE_AXIS = {
  ageLook:     { w: 1.0, sign: -1 },  // 童顔 ↔ 大人顔
  jawSharp:    { w: 0.9, sign: -1 },  // ふんわり輪郭 ↔ シャープ輪郭
  eyeSize:     { w: 0.9, sign: +1 },  // 切れ長 ↔ ぱっちり目
  faceLength:  { w: 0.8, sign: -1 },  // 丸顔 ↔ 面長
  eyeTilt:     { w: 0.8, sign: -1 },  // タレ目 ↔ ツリ目
  browArch:    { w: 0.6, sign: -1 },  // 平行眉 ↔ アーチ眉
  browAngle:   { w: 0.6, sign: -1 },  // 下がり眉 ↔ 上がり眉
  browEyeGap:  { w: 0.5, sign: +1 },  // 彫り深め ↔ 離れ眉
  mouthWidth:  { w: 0.5, sign: -1 },  // おちょぼ口 ↔ 大きな口
  eyeDistance: { w: 0.4, sign: +1 },  // 求心顔 ↔ 遠心顔
  lipThick:    { w: 0.3, sign: +1 },  // 薄い唇 ↔ ぽってり唇
};

/**
 * 推定した好み（理想値 m と重視度 importance）を、系統の1本の軸に落とす。
 *   score  -1（きれい系）〜 +1（かわいい系）
 *   basis  その判定の根拠の確かさ 0..1。
 *          髪や肌など系統に関係ない特徴ばかり重視している人は小さくなる。
 *   top    この判定を決めた特徴（FEATURES の添字）を効いた順に
 */
export function cuteScore(m, importance, usable = null) {
  let num = 0, den = 0, all = 0;
  const parts = [];
  KEYS.forEach((k, i) => {
    if (usable && !usable.has(k)) return;
    all += importance[i];
    const a = CUTE_AXIS[k];
    if (!a) return;
    const w = a.w * importance[i];
    const c = w * a.sign * (m[i] - 0.5) * 2;
    num += c;
    den += w;
    parts.push({ i, c });
  });
  const top = parts.filter((p) => Math.abs(p.c) > 1e-4)
    .sort((x, y) => Math.abs(y.c) - Math.abs(x.c)).map((p) => p.i);
  return { score: den ? num / den : 0, basis: all ? den / all : 0, top };
}

/**
 * プール内の順位にもとづき raw 値を 0..1 に正規化する。
 * 絶対値ではなく「この集団の中で相対的にどのあたりか」に揃える。
 * 同値は同じ正規化値になるよう平均順位を使う。
 */
export function normalizePool(faces) {
  const n = faces.length;
  if (n === 0) return [];
  const out = faces.map((f) => ({ ...f, v: {} }));
  for (const key of KEYS) {
    const idx = out.map((_, i) => i).filter((i) => Number.isFinite(out[i].raw?.[key]));
    idx.sort((a, b) => out[a].raw[key] - out[b].raw[key]);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && out[idx[j + 1]].raw[key] === out[idx[i]].raw[key]) j++;
      const rank = (i + j) / 2;
      const v = idx.length > 1 ? rank / (idx.length - 1) : 0.5;
      for (let k = i; k <= j; k++) out[idx[k]].v[key] = v;
      i = j + 1;
    }
    // 実測できなかった特徴は中央値扱い
    for (const f of out) if (!Number.isFinite(f.v[key])) f.v[key] = 0.5;
  }
  return out;
}
