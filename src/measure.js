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
/**
 * 表示用の切り出し枠を決める。
 * 広いほど頭と肩がよく入るが、画像に収まらなければ意味がないので、
 * 収まる範囲でできるだけ広い枠を選ぶ。単位は両目間距離 d。
 */
// 枠の広さの上限と下限。単位は両目間距離 d。
//
// 枠が広いほど顔は小さく写る。1枚だけ顔が小さいと、その顔は中身ではなく
// 「小さいから」選ばれにくくなり、集めた選択がゆがむ。そろえる必要がある。
//
// 同梱115枚の実測では 113枚が 4.70〜5.13倍 に収まっていた。
// 外れたのは2枚で、どちらも頭頂の実測が髪のほつれや背景のムラを拾って
// 上に外し、その分だけ枠が広がっていた（6.36倍 と 5.35倍）。
// 頭頂の判定を厳しくするより、枠の広さを抑えるほうが確実で副作用がない。
const BOX_MAX = 5.2;
const BOX_MIN = 4.0;

export function chooseBox(geo, W, H, headTop = null) {
  const d = geo._d;
  // 頭頂が実測できていればそこを基準にする。できなければ両目の間隔から見積もる。
  const top0 = (headTop ?? (geo._eyeMid.y - 1.75 * d)) - d * 0.16;
  // あごの下も入れておく（髪の長さは別に元画像で測るが、見た目として肩まで欲しい）
  const need = (geo._chin.y + d * 0.95) - top0;
  // 元画像からはみ出す枠は、足りないぶんを作った画素で埋めることになる。
  // 作った画素は 完全な無地の帯として見えるので、埋める前に枠を縮める。
  // 縮めても下限を割るときだけ、最後の手段として埋める。
  const fits = Math.min(W, H);
  let box = Math.round(Math.min(d * BOX_MAX, Math.max(need, d * BOX_MIN)));
  box = Math.round(Math.max(Math.min(box, fits), Math.min(d * BOX_MIN, fits)));

  // 上限で切り詰めたぶんは上下に振り分ける。頭頂に合わせたままだと、
  // 頭の上だけ詰まってあごの下が余る。
  let oy = Math.round(top0 + Math.max(0, need - box) * 0.5);
  let ox = Math.round(geo._eyeMid.x - box / 2);
  // はみ出すなら、埋めずにまず画像の中へ寄せる
  if (box <= W) ox = Math.min(Math.max(ox, 0), W - box);
  if (box <= H) oy = Math.min(Math.max(oy, 0), H - box);

  const pad = Math.max(-ox, -oy, ox + box - W, oy + box - H, 0);
  return { box, ox, oy, pad };
}

/**
 * 画素から肌・髪を計測する。座標は元画像（検出に使った作業画像）のまま扱う。
 * 切り出し画像ではなく元画像を見るのは、髪の長さを測る帯が
 * 切り出し枠の外にはみ出しても、あるだけの画素で測れるようにするため。
 *
 * @param stride 1画素あたりの要素数。Node の raw は RGB(3)、ブラウザの canvas は RGBA(4)。
 */
export function measurePixels(px, W, H, geo, stride = 3) {
  const d = geo._d;
  const eyeMid = geo._eyeMid;
  const chin = geo._chin;

  // 採取位置は「画像の上」ではなく「顔の上」を基準にする。
  // 顔が傾いた写真でも、頬と髪を狙った位置から採れるようにするため。
  const at = (sideways, upward) => ({
    x: Math.round(eyeMid.x + geo._right.x * sideways * d + geo._up.x * upward * d),
    y: Math.round(eyeMid.y + geo._right.y * sideways * d + geo._up.y * upward * d),
  });

  // 頬から肌色を採る
  const cheekR = Math.max(3, Math.round(d * 0.22));
  const cl = at(-0.95, -0.85), cr = at(0.95, -0.85);
  const cheeks = [
    samplePatch(px, W, H, cl.x, cl.y, cheekR, stride),
    samplePatch(px, W, H, cr.x, cr.y, cheekR, stride),
  ].filter(Boolean);
  const skin = cheeks.length ? {
    r: cheeks.reduce((s, c) => s + c.r, 0) / cheeks.length,
    g: cheeks.reduce((s, c) => s + c.g, 0) / cheeks.length,
    b: cheeks.reduce((s, c) => s + c.b, 0) / cheeks.length,
  } : { r: 200, g: 170, b: 150 };

  // 背景色は四隅から推定（無地背景を想定）。
  // ただし顔が大きく写っていると、下の隅に肩が入り込んで背景ではなくなる。
  // 四隅の平均をそのまま使うと背景色が肩に引っ張られるので、
  // 「多数派で一致している隅」だけを背景とみなす。
  const corners = [
    samplePatch(px, W, H, 4, 4, 4, stride), samplePatch(px, W, H, W - 5, 4, 4, stride),
    samplePatch(px, W, H, 4, H - 5, 4, stride), samplePatch(px, W, H, W - 5, H - 5, 4, stride),
  ].filter(Boolean);
  const mean = (list) => ({
    r: list.reduce((s, c) => s + c.r, 0) / list.length,
    g: list.reduce((s, c) => s + c.g, 0) / list.length,
    b: list.reduce((s, c) => s + c.b, 0) / list.length,
  });
  // 各隅について、それに近い隅がいくつあるかを数え、いちばん大きな集団を採る。
  // ここで見分けたいのは「背景か、写り込んだ肩か」なので許容は広めにとる。
  // 照明のムラは L1 で 100 程度、肩は 200 以上離れる。
  let agree = [];
  for (const c of corners) {
    const near = corners.filter((o) => near2(o, c, 140));
    if (near.length > agree.length) agree = near;
  }
  const bg = agree.length ? mean(agree) : { r: 255, g: 255, b: 255 };
  // 背景がどれだけ均一か（隅どうしの色の開き）
  const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  const bgSpread = agree.length ? Math.max(...agree.map((c) => dist(c, bg))) : 999;

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

  // 髪の長さは「髪色に近く、背景でも肌でもない画素」を数えて測る。
  // 背景が完全な無地である必要はなく、髪と背景の差が背景のムラより
  // 十分大きければ見分けられる（暗い髪 × 明るい背景など）。
  // 照明でうっすら濃淡のある背景を弾かないよう、その関係で判定する。
  const hairBgGap = hair ? dist(hair, bg) : 0;
  const plainBgRgb = agree.length >= 3 && (bgSpread < 70 || bgSpread * 2 < hairBgGap);
  // 背景を除外するときの許容幅。ムラのぶんだけ広げるが、髪まで飲み込まない範囲に留める。
  const bgTol = bgSpread < 70 ? 70 : Math.min(bgSpread + 20, Math.max(70, hairBgGap * 0.5));

  // 明るさを捨てた「色味」でも見分けを試す。
  //
  // 生成画像の背景は上から下へ暗くなっていることが多い。このムラは RGB を
  // ほぼ一様に上下させるだけなので、明るさを割り算で落とすと消える。
  // 一方、灰色の背景（R≒G≒B）と茶色い髪（R>G>B）は色味では大きく離れる。
  // 実例: 髪(168,138,120) と背景(178,182,186) は RGB 距離だと 80 しかなく、
  // 背景のムラ 79 に埋もれて計測できなかったが、色味の距離は 0.069 あり、
  // 背景のムラ 0.005 の10倍以上ある。
  //
  // 逆に黒髪は色味が灰色に近いので、こちらでは分けられない。
  // その場合は明るさの差が大きいので RGB の判定が効く。両方あって初めて広く測れる。
  const chroma = (c) => { const s = c.r + c.g + c.b || 1; return { x: c.r / s, y: c.g / s }; };
  const cdist = (a, b) => {
    const p = chroma(a), q = chroma(b);
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  const bgSpreadC = agree.length ? Math.max(...agree.map((c) => cdist(c, bg))) : 999;
  const hairBgGapC = hair ? cdist(hair, bg) : 0;
  // 色味の差が小さいまま比だけ満たしても意味がないので、絶対値の下限も置く。
  const CHROMA_MIN = 0.010;
  const plainBgChroma = agree.length >= 3 && Boolean(hair)
    && hairBgGapC > CHROMA_MIN && bgSpreadC * 2 < hairBgGapC;
  const plainBg = plainBgRgb || plainBgChroma;
  // 色味で見分けるときの許容幅。RGB で無地と言えるときは、これまで通り RGB で判定する。
  const bgTolC = Math.min(bgSpreadC + 0.004, hairBgGapC * 0.5);

  // 髪の長さ: あごの下に向かって行ごとに走査し、髪がどこまで伸びているかを両目間距離で測る。
  //
  // 「帯の中の髪の割合」にすると、画像が途中で切れたとき上側だけを見ることになり、
  // 頭に近い＝髪がある側に偏って長さを過大評価してしまう。
  // 到達点で測れば、画像が切れても「少なくともここまでは伸びている」として使える。
  const MAX_DEPTH = 2.0, HALF_W = 1.55, ROW_MIN = 0.08;
  const near = (i, c, tol) => (Math.abs(px[i] - c.r) + Math.abs(px[i + 1] - c.g) + Math.abs(px[i + 2] - c.b)) < tol;
  const hx0 = Math.max(0, Math.round(chin.x - HALF_W * d));
  const hx1 = Math.min(W, Math.round(chin.x + HALF_W * d));
  const hy0 = Math.max(0, Math.round(chin.y));
  const hy1 = Math.min(H, Math.round(chin.y + MAX_DEPTH * d));
  const availDepth = (hy1 - hy0) / d;

  // 背景かどうかの判定。RGB で無地と言えるならこれまで通り。
  // 言えないが色味では分かれているときだけ、色味で判定する。
  // 髪と肌の見分けは明るさの差が要るので、そこは RGB のまま。
  const pxColor = (i) => ({ r: px[i], g: px[i + 1], b: px[i + 2] });
  const isBg = plainBgRgb
    ? (i) => near(i, bg, bgTol)
    : (i) => cdist(pxColor(i), bg) < bgTolC;

  let lastHairRow = -1;
  if (hair && plainBg && hx1 > hx0) {
    for (let y = hy0; y < hy1; y++) {
      let c = 0, n = 0;
      for (let x = hx0; x < hx1; x++) {
        n++;
        const i = (y * W + x) * stride;
        if (near(i, hair, 110) && !isBg(i) && !near(i, skin, 80)) c++;
      }
      if (n && c / n >= ROW_MIN) lastHairRow = y;
    }
  }
  // あご下がほとんど写っていないと、長short の区別自体ができない
  const measurable = Boolean(hair) && plainBg && availDepth >= 0.35;
  const extent = lastHairRow < 0 ? 0 : (lastHairRow - hy0) / d;
  // 画像の下端まで髪が続いていた場合は打ち切り（実際はもっと長い可能性がある）
  const censored = measurable && lastHairRow >= hy1 - 1;

  // 頭頂の位置を実測する。両目の間隔からの推定では髪型によって外れるため、
  // 背景が無地であることを利用して、上から見て最初に人物が現れる行を探す。
  let headTop = null;
  if (plainBg) {
    const sx = Math.max(0, Math.round(eyeMid.x - 1.7 * d));
    const ex = Math.min(W, Math.round(eyeMid.x + 1.7 * d));
    const limit = Math.min(H, Math.round(eyeMid.y));
    // 頭頂も同じ理由で、RGB で無地と言えないときは色味で背景を判定する
    const bgHere = plainBgRgb ? (i) => near(i, bg, 70) : (i) => cdist(pxColor(i), bg) < bgTolC;
    outer: for (let y = 0; y < limit; y++) {
      let run = 0;
      for (let x = sx; x < ex; x++) {
        const i = (y * W + x) * stride;
        if (!bgHere(i)) { if (++run >= 4) { headTop = y; break outer; } } else run = 0;
      }
    }
  }

  return {
    skinTone: -lum(skin.r, skin.g, skin.b),                 // 高いほど小麦肌
    hairColor: hair ? lum(hair.r, hair.g, hair.b) : null,   // 高いほど明るい髪
    hairLength: measurable ? extent : null,                 // あご下に伸びている長さ（両目間距離を1とする）
    _skin: skin, _hair: hair, _bg: bg, _hairProbe: hairProbe,
    _scan: { x0: hx0, x1: hx1, y0: hy0, y1: hy1, yHair: lastHairRow },
    _plainBg: plainBg, _plainBgRgb: plainBgRgb, _plainBgChroma: plainBgChroma, _availDepth: availDepth, _censored: censored, _headTop: headTop,
  };
}
