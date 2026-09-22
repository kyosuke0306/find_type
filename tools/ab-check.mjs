#!/usr/bin/env node
// 2つの顔プールを、同じ仮想ユーザーに解かせて比べる。
//
//   node tools/ab-check.mjs <前のjson> <後のjson> [人数]
//   npm run ab-check -- .cache/faces-before.json data/faces.json 1200
//
// 数枚の入れ替えは、前後を別々に平均しても見えない。
// 241枚 → 245枚 は 600人だと「予測一致率 0.825 → 0.817（悪化）」と出たが、
// 1200人の対応のある比較では -0.0007 ± 0.0044 で誤差の範囲だった。
//
// test/simulate.mjs の乱数はユーザーごとに固定（mulberry(1000 + t)）なので、
// 同じ人数で2回走らせれば「同じ人が両方のプールを解いた」ことになる。
// 1人ずつの差を取れば共通のばらつきが消えて、必要な人数がずっと減る。
//
// ± は2標準誤差。これをまたいでいるものは誤差の範囲なので、
// 符号を見て「上がった」「下がった」と言ってはいけない。
import fs from 'node:fs';
import { benchmark } from '../test/simulate.mjs';

const [beforePath, afterPath, trialsArg] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('使い方: node tools/ab-check.mjs <前のjson> <後のjson> [人数]');
  console.error('  前の json は  git show HEAD:data/faces.json > .cache/faces-before.json  で作れます。');
  process.exit(1);
}
const TRIALS = Number(trialsArg ?? 1200);
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).faces;
const before = load(beforePath), after = load(afterPath);

const LABEL = { acc: '予測一致率', hit: '重要特徴Top3的中', hit5: 'Top5内', merr: '理想値誤差' };
// 理想値誤差だけは小さいほうが良い
const LOWER_IS_BETTER = new Set(['merr']);

for (const adaptive of [true, false]) {
  const a = benchmark({ faces: before, rounds: 30, trials: TRIALS, adaptive });
  const b = benchmark({ faces: after, rounds: 30, trials: TRIALS, adaptive });
  console.log(`\n${adaptive ? 'adaptive（本アプリ）' : 'random'}  ${a.size}枚 → ${b.size}枚  (${TRIALS}人)`);
  for (const k of Object.keys(LABEL)) {
    const ds = a.per.map((x, i) => b.per[i][k] - x[k]);
    const m = ds.reduce((s, x) => s + x, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((s, x) => s + (x - m) ** 2, 0) / (ds.length - 1));
    const band = 2 * (sd / Math.sqrt(ds.length));
    const verdict = Math.abs(m) <= band ? '誤差の範囲'
      : (LOWER_IS_BETTER.has(k) ? m < 0 : m > 0) ? '← 良くなった' : '← 悪くなった';
    console.log(`  ${LABEL[k].padEnd(16)} ${a[k].toFixed(4)} → ${b[k].toFixed(4)}   差 ${m >= 0 ? '+' : ''}${m.toFixed(4)} ± ${band.toFixed(4)}  ${verdict}`);
  }
}
