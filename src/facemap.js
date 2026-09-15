// 「顔のどこを見て判断しているか」を出すために、
// 15個の特徴を顔のパーツごとにまとめて重視度を合算する。

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
