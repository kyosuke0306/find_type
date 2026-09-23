// 好み推定モデルの検証。
// 「本当の好み」を持つ仮想ユーザーに選択させ、その回答だけから好みを復元できるか測る。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { KEYS, normalizePool } from '../src/features.js';
import { fit, predict, choosePair, updateStats, newStats, utilityDelta, isPlain } from '../src/model.js';
const W = process.env.PW ? JSON.parse(process.env.PW) : undefined;

// --pool data/faces.json を渡すと、合成プールではなく実際の顔で検証する。
// 画像を追加したときに、そのプールで本当に精度が上がったかを見るため。
const poolAt = process.argv.indexOf('--pool');
const POOL_PATH = poolAt > 0 ? process.argv[poolAt + 1] : null;
const POOL_FACES = POOL_PATH ? JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')).faces : null;

// --attr 3 を渡すと、仮想ユーザーに「かわいい方を選ぶ」性質を持たせる。
// 実際のユーザーは顔のパーツの好み以前にかわいさで選ぶので、
// 同梱プールの精度はこちらのほうが実態に近い。
// 3.0 は「かわいい方をほぼ必ず選ぶ」強さ（sigmoid(3) = 95%）。
// このとき評価は同じ層どうしのペアだけで行う。層をまたぐペアは
// かわいさで決まってしまい、パーツの好みを当てられたかを測れないため。
const attrAt = process.argv.indexOf('--attr');
const ATTR = attrAt > 0 ? Number(process.argv[attrAt + 1]) : 0;

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function makePool(n, rand) {
  const faces = [];
  for (let i = 0; i < n; i++) {
    const v = {};
    // 実際の顔は特徴どうしが相関するので、共通因子を少し混ぜる
    const f1 = rand(), f2 = rand();
    KEYS.forEach((k, idx) => {
      const base = rand();
      const mix = idx % 5 === 0 ? f1 : idx % 5 === 1 ? f2 : base;
      v[k] = Math.max(0, Math.min(1, 0.65 * base + 0.35 * mix));
    });
    faces.push({ id: 'f' + i, v });
  }
  // ランク正規化（本番と同じく相対値にそろえる）
  for (const k of KEYS) {
    const order = [...faces].sort((a, b) => a.v[k] - b.v[k]);
    order.forEach((f, i) => { f.v[k] = i / (order.length - 1); });
  }
  return faces;
}

function makeUser(rand, nImportant = 4) {
  const idx = KEYS.map((_, i) => i).sort(() => rand() - 0.5).slice(0, nImportant);
  const s = KEYS.map(() => 0.05 + rand() * 0.1);
  const m = KEYS.map(() => 0.5);
  for (const i of idx) {
    s[i] = 1.8 + rand() * 3.2;
    const r = rand();
    m[i] = r < 0.42 ? rand() * 0.12 : r < 0.84 ? 0.88 + rand() * 0.12 : 0.42 + rand() * 0.16;
  }
  return { m, a: s.map(Math.log), keys: KEYS, important: idx };
}

const cuteness = (f) => (isPlain(f) ? 0 : 1);

function runSession(pool, user, rounds, rand, adaptive, attr) {
  const comparisons = [];
  // 顔ごとの贔屓（luckOf）も乱数を引く。newStats() のままだと Math.random に
  // 落ちて、同じ種でも毎回ちがう結果になる（tools/ab-check.mjs の対応のある比較が
  // 成り立たなくなる）。アプリ側は毎回ちがってよいので既定のままでよい。
  const stats = newStats(rand);
  let model = null;
  for (let r = 0; r < rounds; r++) {
    let A, B;
    if (adaptive) {
      [A, B] = choosePair(pool, r >= 6 ? model : null, stats, rand, KEYS, W);
    } else {
      const i = Math.floor(rand() * pool.length);
      let j = Math.floor(rand() * (pool.length - 1)); if (j >= i) j++;
      [A, B] = [pool[i], pool[j]];
    }
    const p = sigmoid(utilityDelta(user, A.v, B.v) + attr * (cuteness(A) - cuteness(B)));
    const aWins = rand() < p;
    comparisons.push({ win: aWins ? A.v : B.v, lose: aWins ? B.v : A.v });
    updateStats(stats, A, B);
    if (r >= 5 && (r % 3 === 0 || r === rounds - 1)) model = fit(comparisons);
  }
  return fit(comparisons);
}

function evaluate(pool, user, model, rand, attr) {
  // 未知のペアで「真の好み」と一致するか。
  // かわいさを持たせたときは、それが打ち消し合う同じ層どうしで測る。
  const from = attr ? pool.filter((f) => !isPlain(f)) : pool;
  let ok = 0, n = 600;
  for (let t = 0; t < n; t++) {
    const i = Math.floor(rand() * from.length);
    let j = Math.floor(rand() * (from.length - 1)); if (j >= i) j++;
    const A = from[i].v, B = from[j].v;
    const truth = utilityDelta(user, A, B) > 0;
    const pred = predict(model, A, B) > 0.5;
    if (truth === pred) ok++;
  }
  const trueRank = user.important.slice().sort((x, y) => Math.exp(user.a[y]) * Math.max(user.m[y], 1 - user.m[y]) ** 2 - Math.exp(user.a[x]) * Math.max(user.m[x], 1 - user.m[x]) ** 2);
  const estRank = KEYS.map((_, i) => i).sort((x, y) => model.importance[y] - model.importance[x]);
  const top3 = trueRank.slice(0, 3);
  const hit = top3.filter((i) => estRank.slice(0, 3).includes(i)).length / top3.length;
  const hit5 = top3.filter((i) => estRank.slice(0, 5).includes(i)).length / top3.length;
  // 重要特徴の理想値のズレ
  const merr = top3.reduce((s, i) => s + Math.abs(model.m[i] - user.m[i]), 0) / top3.length;
  return { acc: ok / n, hit, hit5, merr };
}

/**
 * 仮想ユーザーに答えさせて、そのプールでどこまで当てられるかを測る。
 * faces に data/faces.json の faces を渡すと実際の顔で測れる。
 * 渡さなければ合成プールを使う。
 */
export function benchmark({ faces = null, rounds = 30, trials = 60, adaptive = true, attr = 0 } = {}) {
  const real = faces ? normalizePool(faces).map((f) => ({ id: f.file, v: f.v, tier: f.tier, hair: f.hair })) : null;
  const agg = { acc: 0, hit: 0, hit5: 0, merr: 0 };
  // 乱数はユーザーごとに固定（mulberry(1000 + t)）なので、別のプールを同じ人数で
  // 測れば同じ人が両方を解いたことになる。その差を取れば共通のばらつきが消えるので、
  // 1人ずつの結果も返す（tools/ab-check.mjs が使う）。
  const per = [];
  for (let t = 0; t < trials; t++) {
    const rand = mulberry(1000 + t);
    const pool = real ?? makePool(160, rand);
    const user = makeUser(rand);
    const model = runSession(pool, user, rounds, rand, adaptive, attr);
    const e = evaluate(pool, user, model, rand, attr);
    per.push(e);
    for (const k in agg) agg[k] += e[k];
  }
  for (const k in agg) agg[k] /= trials;
  return { ...agg, per, size: real ? real.length : 160 };
}

// 直接実行されたときだけ結果を表示する（他から import しても走らないように）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const POS = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--pool');
  const ROUNDS = Number(POS[0] ?? 30);
  const TRIALS = Number(POS[1] ?? 60);
  for (const adaptive of [false, true]) {
    const r = benchmark({ faces: POOL_FACES, rounds: ROUNDS, trials: TRIALS, adaptive, attr: ATTR });
    const f = (x) => r[x].toFixed(3);
    console.log(`${adaptive ? 'adaptive' : 'random  '} ${POOL_FACES ? `実プール${r.size}枚 ` : ''}${ATTR ? `かわいさ${ATTR} ` : ''}rounds=${ROUNDS}  予測一致率=${f('acc')}  重要特徴Top3的中=${f('hit')}  Top5内=${f('hit5')}  理想値誤差=${f('merr')}`);
  }
}
