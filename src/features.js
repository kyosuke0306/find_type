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
export const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

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
