#!/usr/bin/env node
// リンクを送ったときに出る画像（OG画像）を作る。
//
//   node tools/make-og.mjs
//
// 1200x630 は Facebook / X / Slack / LINE が共通で扱える寸法。
// 右側を切られても文字だけは残るよう、文言は左半分に寄せてある。
//
// 顔は同梱プールから名前で決め打ちして選ぶので、作り直しても同じ絵になる。
// プールから外した顔を指していると止まるので、そのときは FACES を直す。
import fs from 'node:fs';
import sharp from 'sharp';

const W = 1200, H = 630;
const OUT = 'icons/og.png';

// 並べる顔。髪色と明るさが散るように選んである。
const FACES = ['f952.jpg', 'f161.jpg', 'f923.jpg', 'f954.jpg'];

const missing = FACES.filter((f) => !fs.existsSync(`data/faces/${f}`));
if (missing.length) {
  console.error(`data/faces に無い顔があります: ${missing.join(', ')}`);
  console.error('tools/make-og.mjs の FACES を、いまあるファイル名に直してください。');
  process.exit(1);
}

// 顔を並べる位置（2x2）
const D = 200, GAP = 28;
const GX = 700, GY = Math.round((H - (D * 2 + GAP)) / 2);
const at = (n) => ({ left: GX + (n % 2) * (D + GAP), top: GY + Math.floor(n / 2) * (D + GAP) });

const svg = (body) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);

// 地色。アプリの --accent (#3b5b98) を中心に、左上を明るくする。
const background = svg(`
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5375b5"/>
      <stop offset="50%" stop-color="#3b5b98"/>
      <stop offset="100%" stop-color="#27385f"/>
    </linearGradient>
    <radialGradient id="h" cx="0.12" cy="0.02" r="0.75">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#h)"/>`);

// 文字。Liberation Sans はこの環境に入っていて Arial と字幅が同じ。
const FONT = 'Liberation Sans, DejaVu Sans, sans-serif';
const text = svg(`
  <g font-family="${FONT}">
    <text x="82" y="290" font-size="96" font-weight="bold" letter-spacing="-1">
      <tspan fill="#ffffff">Face</tspan><tspan fill="#c5d8f5">Match</tspan>
    </text>
    <text x="86" y="358" font-size="42" fill="#e3ecfb" letter-spacing="0.5">Find your fav face.</text>
    <text x="86" y="420" font-size="26" fill="#ffffff" fill-opacity="0.72">Pick one of two faces. Repeat.</text>
  </g>`);

// 顔にかける丸い枠。地色との境目をはっきりさせるために白く細く回す。
const rings = svg(FACES.map((_, n) => {
  const { left, top } = at(n);
  return `<circle cx="${left + D / 2}" cy="${top + D / 2}" r="${D / 2 - 1}"
     fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3"/>`;
}).join(''));

const circle = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}">
     <circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#fff"/></svg>`);

const faces = await Promise.all(FACES.map(async (f, n) => ({
  input: await sharp(`data/faces/${f}`).resize(D, D)
    .composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer(),
  ...at(n),
})));

// マーク（icons/mark.png）は置かない。小さくすると横顔と f が潰れて判別できず、
// 大きくすると字面とぶつかる。ロゴの字だけで足りる。
await sharp(background)
  .composite([
    ...faces,
    { input: rings, top: 0, left: 0 },
    { input: text, top: 0, left: 0 },
  ])
  .png().toFile(OUT);

const m = await sharp(OUT).metadata();
console.log(`${OUT}  ${m.width}x${m.height}  ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
