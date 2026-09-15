// 「顔のどこを見て判断しているか」を顔の絵で見せる。
//
// 15個の特徴を顔のパーツごとにまとめ、重視度の合計をパーツの濃さにする。
// 数字の表より、顔の絵のどこが濃いかのほうが一目で分かる。

import { KEYS } from './features.js';

export const FACE_PARTS = [
  { id: 'eyes',    name: '目',        keys: ['eyeSize', 'eyeTilt', 'eyeDistance'] },
  { id: 'brows',   name: '眉',        keys: ['browEyeGap', 'browAngle', 'browArch'] },
  { id: 'outline', name: '輪郭',      keys: ['faceLength', 'jawSharp'] },
  { id: 'mouth',   name: '口もと',    keys: ['mouthWidth', 'lipThick'] },
  { id: 'nose',    name: '鼻',        keys: ['noseWidth'] },
  { id: 'hair',    name: '髪',        keys: ['hairColor', 'hairLength'] },
  { id: 'skin',    name: '肌・雰囲気', keys: ['skinTone', 'ageLook'] },
];

/** パーツごとの重視度の割合を、大きい順に返す */
export function partShares(importance) {
  const byKey = Object.fromEntries(KEYS.map((k, i) => [k, importance[i] ?? 0]));
  const rows = FACE_PARTS.map((p) => ({ ...p, sum: p.keys.reduce((s, k) => s + byKey[k], 0) }));
  const total = rows.reduce((s, r) => s + r.sum, 0);
  return rows
    .map((r) => ({ id: r.id, name: r.name, share: total ? r.sum / total : 0 }))
    .sort((a, b) => b.share - a.share);
}

/**
 * 顔の絵を作る。パーツごとに --a（0..1）を渡し、CSS 側で濃さに変える。
 * いちばん見ているパーツが 1 になるようにそろえる。
 */
export function faceMapSvg(shares) {
  const max = Math.max(...shares.map((s) => s.share), 1e-6);
  const a = Object.fromEntries(shares.map((s) => [s.id, (s.share / max).toFixed(3)]));
  const v = (id) => `style="--a:${a[id] ?? 0}"`;
  // 顔がはみ出さない範囲で viewBox を詰めてある（髪の上 y=30 / あご y=150）
  return `<svg viewBox="36 22 108 136" role="img" aria-label="顔のどこを見ているか">
    <path class="fm fm-solid" ${v('hair')} d="M42,104 C36,52 62,30 90,30 C118,30 144,52 138,104
      C136,84 132,70 124,64 C126,54 112,46 90,46 C68,46 54,54 56,64 C48,70 44,84 42,104 Z"/>
    <path class="fm fm-line" ${v('outline')} d="M46,88 C46,56 63,40 90,40 C117,40 134,56 134,88
      C134,119 116,150 90,150 C64,150 46,119 46,88 Z"/>
    <circle class="fm fm-solid fm-soft" ${v('skin')} cx="64" cy="115" r="9"/>
    <circle class="fm fm-solid fm-soft" ${v('skin')} cx="116" cy="115" r="9"/>
    <path class="fm fm-line fm-thick" ${v('brows')} d="M59,79 Q72,71 85,78"/>
    <path class="fm fm-line fm-thick" ${v('brows')} d="M95,78 Q108,71 121,79"/>
    <path class="fm fm-solid" ${v('eyes')} d="M59,94 Q72,84 85,94 Q72,103 59,94 Z"/>
    <path class="fm fm-solid" ${v('eyes')} d="M95,94 Q108,84 121,94 Q108,103 95,94 Z"/>
    <circle class="fm fm-solid" ${v('eyes')} cx="72" cy="94" r="3.4"/>
    <circle class="fm fm-solid" ${v('eyes')} cx="108" cy="94" r="3.4"/>
    <path class="fm fm-line" ${v('nose')} d="M90,102 L90,119 Q90,124 85,123"/>
    <path class="fm fm-solid" ${v('mouth')} d="M74,133 Q90,127 106,133 Q90,144 74,133 Z"/>
  </svg>`;
}
