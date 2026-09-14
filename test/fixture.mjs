#!/usr/bin/env node
// 動作確認用のダミー顔プールを作る。実画像がなくてもアプリの流れを試せる。
//   node test/fixture.mjs && npm start   →  http://localhost:5173/?data=.cache/fixture
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { KEYS } from '../src/features.js';

const OUT = path.resolve('.cache/fixture');
const N = Number(process.argv[2] ?? 80);
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rand = mulberry(42);

await fs.mkdir(path.join(OUT, 'faces'), { recursive: true });
const faces = [];
for (let i = 0; i < N; i++) {
  const raw = Object.fromEntries(KEYS.map((k) => [k, rand()]));
  const gender = i % 2 ? 'male' : 'female';
  const file = `dummy${String(i).padStart(3, '0')}.jpg`;
  const hue = Math.round(rand() * 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
    <rect width="320" height="320" fill="hsl(${hue} 45% ${40 + raw.skinTone * 35}%)"/>
    <circle cx="160" cy="130" r="${60 + raw.eyeSize * 30}" fill="hsl(${hue} 60% 82%)"/>
    <text x="160" y="270" font-size="34" fill="#fff" text-anchor="middle" font-family="sans-serif">${i}</text>
    <text x="160" y="300" font-size="18" fill="#fff" text-anchor="middle" font-family="sans-serif">${gender}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toFile(path.join(OUT, 'faces', file));
  faces.push({ id: `dummy${i}`, file, source: file, gender, genderProbability: 0.99, age: 20 + raw.ageLook * 25, detScore: 0.9, raw });
}
await fs.writeFile(path.join(OUT, 'faces.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: faces.length, faces }, null, 1));
console.log(`ダミープール ${N} 件を ${OUT} に作成しました`);
console.log('確認: npm start → http://localhost:5173/?data=.cache/fixture');
