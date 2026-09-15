// 「顔のどこを見て判断しているか」を出すために、
// 15個の特徴を顔のパーツごとにまとめて重視度を合算する。

import { KEYS } from './features.js';

// 顔のパーツだけ。髪と肌はこのアプリの関心ではないので入れない。
export const FACE_PARTS = [
  { id: 'eyes',    name: '目',      keys: ['eyeSize', 'eyeTilt', 'eyeDistance'] },
  { id: 'brows',   name: '眉',      keys: ['browEyeGap', 'browAngle', 'browArch'] },
  { id: 'outline', name: '輪郭',    keys: ['faceLength', 'jawSharp'] },
  { id: 'mouth',   name: '口もと',  keys: ['mouthWidth', 'lipThick'] },
  { id: 'nose',    name: '鼻',      keys: ['noseWidth'] },
  { id: 'impression', name: '顔立ち', keys: ['ageLook'] },
];

/**
 * パーツごとの重視度の割合を、大きい順に返す。
 * usable を渡すと、そこに無い項目（顔どうしの差が小さくて判定できない項目）は数えない。
 */
export function partShares(importance, usable = null) {
  const byKey = Object.fromEntries(KEYS.map((k, i) => [k, usable && !usable.has(k) ? 0 : (importance[i] ?? 0)]));
  const rows = FACE_PARTS.map((p) => ({ ...p, sum: p.keys.reduce((s, k) => s + byKey[k], 0) }));
  const total = rows.reduce((s, r) => s + r.sum, 0);
  return rows
    .filter((r) => r.sum > 0 || !usable)
    .map((r) => ({ id: r.id, name: r.name, share: total ? r.sum / total : 0 }))
    .sort((a, b) => b.share - a.share);
}
