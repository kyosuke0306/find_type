// アイコンから地色を抜き、マーク（白い f と横顔）だけを透過PNGで切り出す。
// スタート画面では角丸の枠を見せず、背景として敷くために使う。
import sharp from 'sharp';

const { data, info } = await sharp('icons/icon-512.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const b0 = 0;
const BLUE = [data[b0], data[b0 + 1], data[b0 + 2]];   // 左上＝地色
let minX = W, minY = H, maxX = -1, maxY = -1;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * C;
    const d = Math.hypot(data[i] - BLUE[0], data[i + 1] - BLUE[1], data[i + 2] - BLUE[2]);
    if (d < 40) { data[i + 3] = 0; continue; }          // 地色は透明に
    // 地色との境目は半透明にしてギザつきを抑える
    data[i + 3] = Math.min(255, Math.round((d - 40) / 60 * 255));
    if (data[i + 3] > 20) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
}
console.log(`地色 rgb(${BLUE.join(',')}) / マークの範囲 ${minX},${minY} - ${maxX},${maxY}`);

await sharp(data, { raw: { width: W, height: H, channels: C } })
  .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  .png().toFile('icons/mark.png');
const m = await sharp('icons/mark.png').metadata();
console.log('icons/mark.png', m.width + 'x' + m.height);
