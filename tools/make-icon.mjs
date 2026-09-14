#!/usr/bin/env node
// アプリアイコンを作る。
//
//   node tools/make-icon.mjs <元画像>
//
// 角丸部分の白を塗りつぶし、全面が地色になる正方形にしてから各サイズを書き出す。
// ホーム画面に追加したとき、OS 側が独自に角を丸めるため、余白のない全面画像が正しい。
import sharp from 'sharp';

const SRC = process.argv[2];
const OUT = 'icons';
const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const at = (x, y) => (y * W + x) * C;

// 地色は左端中央から採る（確実に地色の領域）
const b0 = at(4, H >> 1);
const BLUE = [data[b0], data[b0 + 1], data[b0 + 2]];
const dist = (i) => Math.hypot(data[i] - BLUE[0], data[i + 1] - BLUE[1], data[i + 2] - BLUE[2]);

// 四隅から、地色でない画素だけを塗りつぶす。
// 白い「f」は下端に接しているが四隅の白とは地色で分断されているので、巻き込まれない。
const seen = new Uint8Array(W * H);
const stack = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
let filled = 0;
while (stack.length) {
  const [x, y] = stack.pop();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const p = y * W + x;
  if (seen[p]) continue;
  const i = at(x, y);
  if (dist(i) <= 60) continue;          // 地色に達したら止める
  seen[p] = 1;
  data[i] = BLUE[0]; data[i + 1] = BLUE[1]; data[i + 2] = BLUE[2];
  filled++;
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}
console.log(`地色 rgb(${BLUE.join(',')}) / 塗りつぶした画素 ${filled}`);

const flat = sharp(data, { raw: { width: W, height: H, channels: C } });
const base = await flat.png().toBuffer();

const sizes = { 'icon-512.png': 512, 'icon-192.png': 192, 'apple-touch-icon.png': 180, 'favicon-32.png': 32 };
for (const [name, size] of Object.entries(sizes)) {
  await sharp(base).resize(size, size, { fit: 'cover' }).png().toFile(`${OUT}/${name}`);
}

// Android のアダプティブアイコン用。外周が削られるので中央 72% に収める。
const inner = Math.round(512 * 0.72);
await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: BLUE[0], g: BLUE[1], b: BLUE[2] } } })
  .composite([{ input: await sharp(base).resize(inner, inner).png().toBuffer(), gravity: 'center' }])
  .png().toFile(`${OUT}/icon-maskable-512.png`);

console.log('書き出し:', [...Object.keys(sizes), 'icon-maskable-512.png'].join(' '));
