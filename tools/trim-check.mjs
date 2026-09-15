#!/usr/bin/env node
// 狙いから外れた顔を「精度が足りてから」外すための判定。
//
//   node tools/trim-check.mjs            判定するだけ
//   node tools/trim-check.mjs --apply    条件を満たしていれば実際に削除する
//
// 枚数を減らすと精度は必ず下がる。だから見た目の好みで先に削るのではなく、
// 精度がしきい値を超えて余裕ができてから削る。
// 外したい顔とそのしきい値は data/trim-candidates.json に書いてある。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmark } from '../test/simulate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const jsonPath = path.join(ROOT, 'data/faces.json');
const listPath = path.join(ROOT, 'data/trim-candidates.json');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const plan = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const { metric, value, rounds, trials } = plan.threshold;
const wanted = new Set(plan.candidates.map((c) => c.file));
const present = plan.candidates.filter((c) => data.faces.some((f) => f.file === c.file));

const LABEL = { acc: '予測一致率', hit: '重要項目Top3の的中', hit5: 'Top5内' };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`いまのプール: ${data.faces.length} 枚`);
if (!present.length) {
  console.log('外したい顔はもう残っていません。');
  process.exit(0);
}

const now = benchmark({ faces: data.faces, rounds, trials });
console.log(`${LABEL[metric] ?? metric}: ${pct(now[metric])}（${rounds}問・仮想ユーザー${trials}人）`);
console.log(`しきい値: ${pct(value)}`);
console.log('');
console.log(`外す候補 ${present.length} 枚:`);
for (const c of present) console.log(`  ${c.file}  ${c.why}`);
console.log('');

if (now[metric] < value) {
  const short = value - now[metric];
  console.log(`まだ ${pct(short)} 足りません。顔を足してから、もう一度実行してください。`);
  console.log('削除はしていません。');
  process.exit(0);
}

const after = benchmark({ faces: data.faces.filter((f) => !wanted.has(f.file)), rounds, trials });
console.log(`外したあとの見込み: ${data.faces.length - present.length} 枚 / ${LABEL[metric] ?? metric} ${pct(after[metric])}`);

if (after[metric] < value) {
  console.log(`外すとしきい値を下回ります。もう少し顔を足してからにしてください。`);
  console.log('削除はしていません。');
  process.exit(0);
}

if (!apply) {
  console.log('');
  console.log('条件を満たしています。実際に削除するには --apply を付けて実行してください。');
  process.exit(0);
}

for (const c of present) {
  const at = path.join(ROOT, 'data/faces', c.file);
  if (fs.existsSync(at)) fs.unlinkSync(at);
}
data.faces = data.faces.filter((f) => !wanted.has(f.file));
fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
plan.candidates = plan.candidates.filter((c) => !wanted.has(c.file));
fs.writeFileSync(listPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log('');
console.log(`${present.length} 枚を削除しました。残り ${data.faces.length} 枚。`);
