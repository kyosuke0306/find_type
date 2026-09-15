#!/usr/bin/env node
// 狙いから外れた顔を外すための判定。
//
//   node tools/trim-check.mjs            判定するだけ
//   node tools/trim-check.mjs --apply    条件を満たしていれば実際に削除する
//
// このアプリの目的は2つある（README「目的」）。
//   1. 自分の顔の好みを知る
//   2. かわいい人を見て楽しむ
// 枚数を減らすと 1 の精度は下がる。一方、狙いから明らかに外れた顔が
// 混ざっていること自体が 2 の損失になる。そこで候補を2種類に分ける。
//
//   must: true   明らかに外れている。精度に関わらず外す（枚数の下限だけ守る）
//   must なし    判断が分かれる。精度に余裕があるときだけ外す
//
// 外したい顔としきい値は data/trim-candidates.json に書いてある。
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

// 診断が成り立たなくなる枚数までは減らさない（アプリ側の下限 12 枚に余裕を持たせる）
const MIN_FACES = 16;

const LABEL = { acc: '予測一致率', hit: '重要項目Top3の的中', hit5: 'Top5内' };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`いまのプール: ${data.faces.length} 枚`);
if (!present.length) {
  console.log('外したい顔はもう残っていません。');
  process.exit(0);
}

const must = present.filter((c) => c.must);
const optional = present.filter((c) => !c.must);

const now = benchmark({ faces: data.faces, rounds, trials });
console.log(`${LABEL[metric] ?? metric}: ${pct(now[metric])}（${rounds}問・仮想ユーザー${trials}人）`);
console.log(`しきい値: ${pct(value)}`);
console.log('');
if (must.length) {
  console.log(`明らかに外れている ${must.length} 枚（精度に関わらず外す）:`);
  for (const c of must) console.log(`  ${c.file}  ${c.why}`);
}
if (optional.length) {
  console.log(`判断が分かれる ${optional.length} 枚（精度に余裕があれば外す）:`);
  for (const c of optional) console.log(`  ${c.file}  ${c.why}`);
}
console.log('');

if (data.faces.length - must.length < MIN_FACES) {
  console.log(`外すと ${MIN_FACES} 枚を下回ります。顔を足してからにしてください。`);
  console.log('削除はしていません。');
  process.exit(0);
}

if (!optional.length) {
  // 明らかに外れている分だけなら、精度を測るまでもなく外す
  applyTrim(must);
  process.exit(0);
}

if (now[metric] < value) {
  const short = value - now[metric];
  console.log(`まだ ${pct(short)} 足りません。顔を足してから、もう一度実行してください。`);
  console.log('削除はしていません。');
  process.exit(0);
}

const after = benchmark({ faces: data.faces.filter((f) => !wanted.has(f.file)), rounds, trials });
console.log(`全部外したあとの見込み: ${data.faces.length - present.length} 枚 / ${LABEL[metric] ?? metric} ${pct(after[metric])}`);

if (after[metric] < value) {
  console.log('判断が分かれる分まで外すとしきい値を下回ります。');
  applyTrim(must);
  process.exit(0);
}

applyTrim(present);

function applyTrim(list) {
  if (!list.length) {
    console.log('外すものはありません。');
    return;
  }
  if (!apply) {
    console.log('');
    console.log(`${list.length} 枚が削除対象です。実際に削除するには --apply を付けて実行してください。`);
    return;
  }
  const names = new Set(list.map((c) => c.file));
  for (const c of list) {
    const at = path.join(ROOT, 'data/faces', c.file);
    if (fs.existsSync(at)) fs.unlinkSync(at);
  }
  data.faces = data.faces.filter((f) => !names.has(f.file));
  fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  plan.candidates = plan.candidates.filter((c) => !names.has(c.file));
  fs.writeFileSync(listPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log('');
  console.log(`${list.length} 枚を削除しました。残り ${data.faces.length} 枚。`);
}
