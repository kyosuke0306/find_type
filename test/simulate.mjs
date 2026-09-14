// 好み推定モデルの検証。
// 「本当の好み」を持つ仮想ユーザーに選択させ、その回答だけから好みを復元できるか測る。
import { KEYS } from '../src/features.js';
import { fit, predict, choosePair, updateStats, newStats, utilityDelta } from '../src/model.js';
const W = process.env.PW ? JSON.parse(process.env.PW) : undefined;

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

function runSession(pool, user, rounds, rand, adaptive) {
  const comparisons = [];
  const stats = newStats();
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
    const p = sigmoid(utilityDelta(user, A.v, B.v));
    const aWins = rand() < p;
    comparisons.push({ win: aWins ? A.v : B.v, lose: aWins ? B.v : A.v });
    updateStats(stats, A, B);
    if (r >= 5 && (r % 3 === 0 || r === rounds - 1)) model = fit(comparisons);
  }
  return fit(comparisons);
}

function evaluate(pool, user, model, rand) {
  // 未知のペアで「真の好み」と一致するか
  let ok = 0, n = 600;
  for (let t = 0; t < n; t++) {
    const i = Math.floor(rand() * pool.length);
    let j = Math.floor(rand() * (pool.length - 1)); if (j >= i) j++;
    const A = pool[i].v, B = pool[j].v;
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

const ROUNDS = Number(process.argv[2] ?? 30);
const TRIALS = Number(process.argv[3] ?? 60);
for (const adaptive of [false, true]) {
  const agg = { acc: 0, hit: 0, hit5: 0, merr: 0 };
  for (let t = 0; t < TRIALS; t++) {
    const rand = mulberry(1000 + t);
    const pool = makePool(160, rand);
    const user = makeUser(rand);
    const model = runSession(pool, user, ROUNDS, rand, adaptive);
    const e = evaluate(pool, user, model, rand);
    for (const k in agg) agg[k] += e[k];
  }
  const f = (x) => (agg[x] / TRIALS).toFixed(3);
  console.log(`${adaptive ? 'adaptive' : 'random  '} rounds=${ROUNDS}  予測一致率=${f('acc')}  重要特徴Top3的中=${f('hit')}  Top5内=${f('hit5')}  理想値誤差=${f('merr')}`);
}
