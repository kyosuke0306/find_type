#!/usr/bin/env node
// 最初の画面に出している精度が、いまのプールの実測と合っているか確かめる。
//
//   node tools/acc-check.mjs [仮想ユーザー数]
//
// 画面の数字は src/app.js の rounds-choices に直接書いてある。
// 顔を足したり、較正やペアの選び方を変えたりすると実測が動くので、
// そのたびにここで確かめて書き換える。ずれたまま公開すると、
// 「20問で80%」と言いながら実際は違う、という嘘になる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmark } from '../test/simulate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIALS = Number(process.argv[2] ?? 400);
const TOLERANCE = 1;   // 何ポイントまでのずれを許すか

const src = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const shown = [...src.matchAll(/\{ v: (\d+), label: '[^']*', acc: (\d+) \}/g)]
  .map((m) => ({ rounds: Number(m[1]), acc: Number(m[2]) }));
if (!shown.length) {
  console.error('src/app.js から精度の記述を見つけられませんでした。');
  process.exit(1);
}

const faces = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/faces.json'), 'utf8')).faces;
console.log(`${faces.length}枚・仮想ユーザー${TRIALS}人で確かめます（許容 ±${TOLERANCE}ポイント）\n`);
console.log('問数   画面   実測   差');

let bad = 0;
for (const s of shown) {
  const r = benchmark({ faces, rounds: s.rounds, trials: TRIALS, adaptive: true });
  const real = r.acc * 100;
  const diff = real - s.acc;
  const ng = Math.abs(diff) > TOLERANCE;
  if (ng) bad++;
  console.log(String(s.rounds).padStart(3) + '問' + String(s.acc).padStart(7) + '%'
    + real.toFixed(1).padStart(7) + '%' + (diff >= 0 ? '  +' : '  ') + diff.toFixed(1)
    + (ng ? '  ← 直す' : ''));
}
console.log('');
if (bad) {
  console.log(`${bad}件がずれています。src/app.js の acc を実測の値に書き換えてください。`);
  process.exit(1);
}
console.log('画面の数字は実測と合っています。');
