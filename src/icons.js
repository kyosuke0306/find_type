// 画面で使うアイコン。外部依存を増やしたくないので、すべて手書きの SVG。
// 24×24・線幅2の線画で統一し、色は currentColor に従う。

const svg = (body, opts = {}) =>
  `<svg class="icon ${opts.cls ?? ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="${opts.w ?? 2}" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true">${body}</svg>`;

/* ---------- 診断項目のアイコン ---------- */
const FEATURE_ICONS = {
  // 輪郭の縦横比：縦長の輪郭と縦向きの矢印
  faceLength: '<ellipse cx="12" cy="12" rx="5.5" ry="8"/><path d="M12 2.5v2M12 19.5v2"/>',
  // あごのライン：頬からあごへ絞れていく線
  jawSharp: '<path d="M5 5v5a7 7 0 0 0 7 9 7 7 0 0 0 7-9V5"/><path d="M9 15.5 12 19l3-3.5"/>',
  // 目の大きさ：大きな瞳の目
  eyeSize: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3.2"/>',
  // 目尻の角度：傾いた目
  eyeTilt: '<path d="M3 14.5c3-4.5 6.5-6.5 11-8"/><path d="M3 14.5c4 2.5 8 2 11-1.5"/><circle cx="9" cy="12" r="1.6"/>',
  // 目の間隔：離れた2つの目と両矢印
  eyeDistance: '<circle cx="5.5" cy="10" r="2.5"/><circle cx="18.5" cy="10" r="2.5"/><path d="M9 17h6M9 17l1.5-1.5M9 17l1.5 1.5M15 17l-1.5-1.5M15 17l-1.5 1.5"/>',
  // 眉と目の距離：眉と目のあいだの縦矢印
  browEyeGap: '<path d="M5 6.5c2.5-2 9-2 14 0"/><path d="M4.5 16.5c3-3.5 12-3.5 15 0"/><path d="M12 9v4M12 9l-1.2 1.2M12 9l1.2 1.2M12 13l-1.2-1.2M12 13l1.2-1.2"/>',
  // 眉の角度：上がった眉
  browAngle: '<path d="M4 15 20 8"/><path d="M4 19h16"/>',
  // 眉の形：アーチ
  browArch: '<path d="M3 15C6 7 18 7 21 15"/>',
  // 小鼻の広さ：鼻と横矢印
  noseWidth: '<path d="M12 4v8.5c0 1.5-1 2.5-2.5 2.5"/><path d="M7 18c1.5 1.5 8.5 1.5 10 0"/><path d="M4 21h3M17 21h3"/>',
  // 口の大きさ：口と横矢印
  mouthWidth: '<path d="M4 12c4-3 12-3 16 0-4 4-12 4-16 0Z"/><path d="M2 18h4M18 18h4"/>',
  // 唇の厚さ：上下に厚い唇
  lipThick: '<path d="M3 12c3-4 6-4 9-1 3-3 6-3 9 1"/><path d="M3 12c3 5 15 5 18 0"/>',
  // 顔立ちの印象：顔ときらめき
  ageLook: '<circle cx="11" cy="12" r="7.5"/><path d="M8.5 11h.01M13.5 11h.01"/><path d="M8.5 15c1.6 1.2 3.4 1.2 5 0"/><path d="M20 4.5 20.8 6.7 23 7.5 20.8 8.3 20 10.5 19.2 8.3 17 7.5 19.2 6.7Z"/>',
  // 肌の明るさ：太陽
  skinTone: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  // 髪の明るさ：毛束と色の点
  hairColor: '<path d="M5 20c0-7 1.5-12 7-16 5.5 4 7 9 7 16"/><circle cx="12" cy="9.5" r="1.6" fill="currentColor" stroke="none"/>',
  // 髪の長さ：長く垂れる髪と下向き矢印
  hairLength: '<path d="M6 4c4-2.5 8-2.5 12 0"/><path d="M6 4c-1 5-1 11 0 16M18 4c1 5 1 11 0 16"/><path d="M12 8v9M12 17l-1.5-1.5M12 17l1.5-1.5"/>',
};

/* ---------- 画面で使うアイコン ---------- */
const UI_ICONS = {
  female: '<circle cx="12" cy="8.5" r="5"/><path d="M12 13.5V21M8.5 18h7"/>',
  male: '<circle cx="10" cy="14" r="5"/><path d="M14 10 20.5 3.5M15 3.5h5.5V9"/>',
  both: '<circle cx="8" cy="10" r="4"/><circle cx="16" cy="14" r="4"/>',
  heart: '<path d="M12 20s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7.6 4.5 4.5 0 0 1 19.5 10c0 5.3-7.5 10-7.5 10Z"/>',
  heartFill: '<path d="M12 20s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7.6 4.5 4.5 0 0 1 19.5 10c0 5.3-7.5 10-7.5 10Z" fill="currentColor"/>',
  undo: '<path d="M4 10h10a5 5 0 0 1 0 10h-3"/><path d="M4 10 8 6M4 10l4 4"/>',
  skip: '<path d="M5 5v14l9-7Z"/><path d="M19 5v14"/>',
  play: '<path d="M7 4.5v15l13-7.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5"/>',
  replay: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/>',
  crown: '<path d="M3 18h18M4 8l4 3.5L12 5l4 6.5L20 8l-1.5 8h-13Z"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="9" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/>',
  check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
};

export const featureIcon = (key, opts) => svg(FEATURE_ICONS[key] ?? UI_ICONS.sparkle, opts);
export const icon = (name, opts) => svg(UI_ICONS[name] ?? '', opts);

/** 2枚の顔を見比べる様子のイラスト。スタート画面の主役。 */
export const heroArt = () => `
<svg class="hero-art" viewBox="0 0 240 130" fill="none" aria-hidden="true">
  <g class="hero-card hero-card-l">
    <rect x="14" y="16" width="82" height="98" rx="14" class="hero-plate"/>
    <circle cx="55" cy="56" r="20" class="hero-head"/>
    <path d="M35 100c0-12 9-20 20-20s20 8 20 20" class="hero-head"/>
    <path d="M47 54c2-2 5-2 7 0M60 54c2-2 5-2 7 0" class="hero-face"/>
  </g>
  <g class="hero-card hero-card-r">
    <rect x="144" y="16" width="82" height="98" rx="14" class="hero-plate"/>
    <circle cx="185" cy="56" r="20" class="hero-head"/>
    <path d="M165 100c0-12 9-20 20-20s20 8 20 20" class="hero-head"/>
    <path d="M177 54h7M190 54h7" class="hero-face"/>
  </g>
  <g class="hero-heart">
    <path d="M120 78s-14-8.8-14-18.6A8.4 8.4 0 0 1 120 54a8.4 8.4 0 0 1 14 5.4C134 69.2 120 78 120 78Z"/>
  </g>
</svg>`;
