// 顔の特徴量を実測する処理。Node（tools/analyze.mjs）とブラウザ（src/import.js）で共有する。
// 入力はランドマーク座標と画素配列だけで、どちらの環境にも依存しない。

/* ---------- 幾何ユーティリティ ---------- */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const slice = (P, a, b) => P.slice(a, b + 1);

/** 目の傾きを打ち消した座標系にランドマークを回転させる（計測を頭の傾きから独立させる） */
export function deroll(P) {
  const eyeR = mean(slice(P, 36, 41));
  const eyeL = mean(slice(P, 42, 47));
  const ang = Math.atan2(eyeL.y - eyeR.y, eyeL.x - eyeR.x);
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const o = mean([eyeR, eyeL]);
  return P.map((p) => {
    const dx = p.x - o.x, dy = p.y - o.y;
    return { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c };
  });
}

/**
 * 68点ランドマークから顔の形状特徴を実測する。
 * すべて両目間の距離 d または顔幅で割り、写真の大きさに依存しない量にしている。
 */
export function measureGeometry(P0) {
  const P = deroll(P0);
  const eyeR = mean(slice(P, 36, 41));   // 画像左側 = 本人の右目
  const eyeL = mean(slice(P, 42, 47));
  const d = dist(eyeR, eyeL);
  const eyeMid = mean([eyeR, eyeL]);
  const chin = P[8];
  const faceW = dist(P[0], P[16]);

  const eyeOpen = (a, b, c, e) => Math.abs((P[a].y + P[b].y) / 2 - (P[c].y + P[e].y) / 2);
  const eyeH = (eyeOpen(37, 38, 41, 40) + eyeOpen(43, 44, 47, 46)) / 2;
  const eyeW = (dist(P[36], P[39]) + dist(P[42], P[45])) / 2;

  // 眉山が「眉頭-眉尻を結んだ線」からどれだけ持ち上がっているか
  const archOf = (inner, peak, outer) => {
    const t = (P[peak].x - P[inner].x) / ((P[outer].x - P[inner].x) || 1e-6);
    const lineY = P[inner].y + (P[outer].y - P[inner].y) * t;
    return (lineY - P[peak].y) / d;
  };

  // 画素の採取は「画像の上」ではなく「顔の上」を基準にする。
  // 顔が傾いた写真でも、頬と髪を狙った位置から採れるようにするため。
  const eyeR0 = mean(slice(P0, 36, 41));
  const eyeL0 = mean(slice(P0, 42, 47));
  const len = Math.hypot(eyeL0.x - eyeR0.x, eyeL0.y - eyeR0.y) || 1;
  const right = { x: (eyeL0.x - eyeR0.x) / len, y: (eyeL0.y - eyeR0.y) / len };
  const up = { x: right.y, y: -right.x };

  return {
    faceLength: (chin.y - eyeMid.y) / faceW,
    jawSharp: -dist(P[5], P[11]) / faceW,
    eyeSize: eyeH / d,
    eyeTilt: ((P[39].y - P[36].y) + (P[42].y - P[45].y)) / 2 / d,
    eyeDistance: dist(P[39], P[42]) / faceW,
    browEyeGap: ((P[37].y - P[19].y) + (P[44].y - P[24].y)) / 2 / d,
    browAngle: -((P[17].y - P[21].y) + (P[26].y - P[22].y)) / 2 / d,
    browArch: (archOf(21, 19, 17) + archOf(22, 24, 26)) / 2,
    noseWidth: dist(P[31], P[35]) / d,
    mouthWidth: dist(P[48], P[54]) / d,
    lipThick: (Math.abs(P[62].y - P[51].y) + Math.abs(P[57].y - P[66].y)) / d,
    _eyeAspect: eyeH / eyeW,
    _d: d,
    _eyeMid: mean([eyeR0, eyeL0]),
    _chin: P0[8],
    _faceW: faceW,
    _right: right,
    _up: up,
  };
}

/* ---------- 画素からの計測（肌・髪） ---------- */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const near2 = (a, b, tol) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < tol;

export function samplePatch(px, W, H, cx, cy, r, stride = 3) {
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
      const i = (y * W + x) * stride;
      sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
    }
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n, n } : null;
}

/**
 * 切り出し済み画像の画素から、肌の明るさ・髪の明るさ・髪の長さを推定する。
 * 髪の長さは「頭頂部で採取した髪色に近い画素が、あごより下にどれだけ広がっているか」で測る。
 */
export function measurePixels(px, W, H, geo, scale, ox, oy, stride = 3) {
  // stride は 1 画素あたりの要素数。Node の raw は RGB(3)、ブラウザの canvas は RGBA(4)。
  const toCrop = (p) => ({ x: Math.round((p.x - ox) * scale), y: Math.round((p.y - oy) * scale) });
  const d = geo._d * scale;
  const eyeMid = toCrop(geo._eyeMid);
  const chin = toCrop(geo._chin);

  // 頬（目と口の外側）から肌色を採る
  const cheekR = Math.max(3, Math.round(d * 0.22));
  const at = (sideways, upward) => ({
    x: Math.round(eyeMid.x + geo._right.x * sideways * d + geo._up.x * upward * d),
    y: Math.round(eyeMid.y + geo._right.y * sideways * d + geo._up.y * upward * d),
  });
  const cheekL = at(-0.95, -0.85), cheekRt = at(0.95, -0.85);
  const cheeks = [
    samplePatch(px, W, H, cheekL.x, cheekL.y, cheekR, stride),
    samplePatch(px, W, H, cheekRt.x, cheekRt.y, cheekR, stride),
  ].filter(Boolean);
  const skin = cheeks.length
    ? { r: mean(cheeks.map((c) => ({ x: c.r, y: 0 }))).x, g: mean(cheeks.map((c) => ({ x: c.g, y: 0 }))).x, b: mean(cheeks.map((c) => ({ x: c.b, y: 0 }))).x }
    : { r: 200, g: 170, b: 150 };

  // 背景色は四隅から推定（生成画像は無地背景を想定）
  const corners = [
    samplePatch(px, W, H, 4, 4, 4, stride), samplePatch(px, W, H, W - 5, 4, 4, stride),
    samplePatch(px, W, H, 4, H - 5, 4, stride), samplePatch(px, W, H, W - 5, H - 5, 4, stride),
  ].filter(Boolean);
  const bg = corners.length ? {
    r: corners.reduce((s, c) => s + c.r, 0) / corners.length,
    g: corners.reduce((s, c) => s + c.g, 0) / corners.length,
    b: corners.reduce((s, c) => s + c.b, 0) / corners.length,
  } : { r: 255, g: 255, b: 255 };

  // 髪の長さは「髪色に近く、背景でも肌でもない画素」を数えて測るため、
  // 背景が無地でないと成立しない。四隅がばらついていたら計測不能として扱う。
  const plainBg = corners.length === 4 && corners.every((c) => near2(c, bg, 70));

  // 髪色の採取。頭の大きさは顔ごとに違うので固定距離では外すことがある。
  // 額の上から頭頂・こめかみへ順に探索し、「肌でも背景でもない」最初の点を髪とみなす。
  const hairR = Math.max(3, Math.round(d * 0.3));
  const HAIR_PROBES = [[0, 1.15], [0, 1.45], [0, 1.75], [-0.95, 1.15], [0.95, 1.15], [-1.35, 0.55], [1.35, 0.55]];
  let hair = null, hairProbe = null;
  for (const [sx, uy] of HAIR_PROBES) {
    const q = at(sx, uy);
    const c = samplePatch(px, W, H, q.x, q.y, hairR, stride);
    if (!c) continue;
    if (near2(c, skin, 55) || near2(c, bg, 60)) continue;
    hair = c; hairProbe = q; break;
  }

  // あごより下の左右領域で「髪色に近い/背景でも肌でもない」画素の割合 = 髪の長さ
  const near = (i, c, tol) => (Math.abs(px[i] - c.r) + Math.abs(px[i + 1] - c.g) + Math.abs(px[i + 2] - c.b)) < tol;
  let hairPx = 0, total = 0;
  if (hair && plainBg) {
    const y0 = Math.min(H - 1, chin.y), y1 = H;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * stride;
        total++;
        if (near(i, hair, 110) && !near(i, bg, 70) && !near(i, skin, 80)) hairPx++;
      }
    }
  }

  // 採取点が背景や肌と見分けられないとき（薄毛・髪を上げている等）は
  // 髪の計測を「不能」として返す。正規化側で中央値扱いになる。
  return {
    skinTone: -lum(skin.r, skin.g, skin.b),                 // 高いほど小麦肌
    hairColor: hair ? lum(hair.r, hair.g, hair.b) : null,   // 高いほど明るい髪
    hairLength: hair && plainBg ? (total ? hairPx / total : 0) : null, // 高いほどロング（無地背景のときだけ）
    _skin: skin, _hair: hair, _bg: bg, _hairProbe: hairProbe, _plainBg: plainBg,
  };
}

