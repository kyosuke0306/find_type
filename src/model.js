// 好み推定モデル。
//
// 「理想点モデル」を使う。特徴 k ごとに理想値 m_k と重視度 s_k = exp(a_k) があり、
// 顔 x の好ましさを  u(x) = -Σ_k s_k (x_k - m_k)^2  とする。
// 2択の勝率は P(A) = sigmoid(u(A) - u(B))。
// これを比較データから MAP 推定する（m は 0.5、a は小さめの値へ引く事前分布つき）。
//
// 線形モデル（重み付き和）と違い「中くらいが好き」も表現でき、
// 「重視していない特徴」は重視度がほぼ 0 に落ちるので、こだわりの有無を分離できる。

import { KEYS } from './features.js';
import { SURFACE_BIAS } from './calibration.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function utilityDelta(model, a, b, keys = KEYS) {
  let d = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const s = Math.exp(model.a[i]);
    const dm = model.m[i];
    d += s * ((b[k] - dm) ** 2 - (a[k] - dm) ** 2);
  }
  return d;
}

/** A が選ばれる予測確率 */
export function predict(model, a, b, keys = KEYS) {
  return sigmoid(utilityDelta(model, a, b, keys));
}

/** 顔 1 枚のスコア（大きいほど好み） */
export function score(model, x, keys = KEYS) {
  let u = 0;
  for (let i = 0; i < keys.length; i++) u -= Math.exp(model.a[i]) * (x[keys[i]] - model.m[i]) ** 2;
  return u;
}

const DEFAULTS = {
  iters: 900,
  lr: 0.08,
  lambdaM: 0.8,   // 理想値を 0.5 へ引く強さ
  lambdaA: 0.35,  // 重視度を a0 へ引く強さ
  a0: -1.0,
};

/**
 * 比較データから理想点モデルを推定する。
 * @param {Array<{win: Object, lose: Object}>} comparisons 正規化済み特徴ベクトル
 */
export function fit(comparisons, keys = KEYS, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const K = keys.length;
  const m = new Array(K).fill(0.5);
  const a = new Array(K).fill(o.a0);
  // Adam
  const mm = new Array(K * 2).fill(0), vv = new Array(K * 2).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;

  if (comparisons.length === 0) return finish(m, a, keys, comparisons);

  for (let t = 1; t <= o.iters; t++) {
    const gm = new Array(K).fill(0), ga = new Array(K).fill(0);
    for (const c of comparisons) {
      // win 側を A とみなすので y = 1
      let d = 0;
      const s = new Array(K), dwin = new Array(K), dlose = new Array(K);
      for (let i = 0; i < K; i++) {
        s[i] = Math.exp(a[i]);
        dwin[i] = c.win[keys[i]] - m[i];
        dlose[i] = c.lose[keys[i]] - m[i];
        d += s[i] * (dlose[i] ** 2 - dwin[i] ** 2);
      }
      const err = sigmoid(d) - 1; // p - y
      for (let i = 0; i < K; i++) {
        ga[i] += err * s[i] * (dlose[i] ** 2 - dwin[i] ** 2);
        gm[i] += err * s[i] * 2 * (c.win[keys[i]] - c.lose[keys[i]]);
      }
    }
    for (let i = 0; i < K; i++) {
      gm[i] += 2 * o.lambdaM * (m[i] - 0.5);
      ga[i] += 2 * o.lambdaA * (a[i] - o.a0);
    }
    for (let i = 0; i < K * 2; i++) {
      const g = i < K ? gm[i] : ga[i - K];
      mm[i] = b1 * mm[i] + (1 - b1) * g;
      vv[i] = b2 * vv[i] + (1 - b2) * g * g;
      const step = o.lr * (mm[i] / (1 - b1 ** t)) / (Math.sqrt(vv[i] / (1 - b2 ** t)) + eps);
      if (i < K) m[i] = Math.max(0, Math.min(1, m[i] - step));
      else a[i - K] = Math.max(-6, Math.min(4, a[i - K] - step));
    }
  }
  return finish(m, a, keys, comparisons);
}

function finish(m, a, keys, comparisons) {
  const model = { m, a, keys };
  // 重視度 = その特徴が 0..1 の範囲で生む好ましさの落差
  const raw = keys.map((_, i) => Math.exp(a[i]) * Math.max(m[i], 1 - m[i]) ** 2);
  // 項目ごとに水準が違うぶんをそろえてから並べる（src/calibration.js）。
  // そろえないと、理想値が端へ寄りやすい項目が重視されていなくても上位に出る。
  const adj = keys.map((k, i) => raw[i] * (SURFACE_BIAS[k] ?? 1));
  const total = adj.reduce((s, x) => s + x, 0) || 1;
  model.importance = adj.map((x) => x / total);
  model.rawImportance = raw;
  // その特徴に差がある比較が何件あったか（推定の裏づけの厚さ）
  model.support = keys.map((k) =>
    comparisons.filter((c) => Math.abs(c.win[k] - c.lose[k]) >= 0.25).length);
  model.trainAccuracy = accuracy(model, comparisons, keys);
  return model;
}

export function accuracy(model, comparisons, keys = KEYS) {
  if (!comparisons.length) return 0;
  let ok = 0;
  for (const c of comparisons) if (utilityDelta(model, c.win, c.lose, keys) > 0) ok++;
  return ok / comparisons.length;
}

/**
 * Leave-one-out 交差検証。1件を除いて学習し、その1件を当てられるかを見る。
 * 学習データへの当てはまりではなく「次の選択を予測できるか」= 好みの一貫性。
 */
// 1件ごとに学習し直すので件数が増えると重い。
// 90問では総当たりだと画面が数秒止まるため、等間隔に間引く。
// 平均を取る指標なので、間引いても値はほとんど変わらない。
const MAX_FOLDS = 40;

export function looAccuracy(comparisons, keys = KEYS, opts = {}) {
  const n = comparisons.length;
  if (n < 6) return null;
  const folds = Math.min(n, MAX_FOLDS);
  let ok = 0;
  for (let t = 0; t < folds; t++) {
    const i = Math.floor((t * n) / folds);
    const rest = comparisons.filter((_, j) => j !== i);
    const mdl = fit(rest, keys, { iters: 350, ...opts });
    if (utilityDelta(mdl, comparisons[i].win, comparisons[i].lose, keys) > 0) ok++;
  }
  return ok / folds;
}

/**
 * 次に出す 2 枚を選ぶ。
 * 写真プールからの選択なので「差がつく特徴を絞る」ことはできないが、
 *  - まだ観測の薄い特徴で差がついている
 *  - すでに十分わかった特徴では差が小さい
 *  - 現モデルの予測が五分五分（＝情報量が大きい）
 * ペアを候補の中から選ぶことで、少ない回数でも各特徴を見分けられるようにする。
 *
 * かわいさの層（tier）が違う顔どうしは並べない。
 * かわいい顔とそうでない顔を並べると、誰でもかわいい方を選ぶので
 * その回は「その人の好み」ではなく「世間一般のかわいさ」しか測れない。
 * しかも顔のパーツとかわいさには相関があるため（あごのラインなど）、
 * 混ぜたまま出すと全員が同じ結果に寄っていく。
 * 同じ層どうしに限れば、かわいさの差が打ち消し合ってパーツの好みだけが残る。
 *
 * 髪の長さでも同じことが起きるが、こちらは層ではなくペナルティで扱う
 * （W.hair。理由は下の scoring の中のコメント）。
 */
// test/simulate.mjs で調整した重み
export const PAIR_WEIGHTS = { gain: 2, spread: 0, unc: 1, fatigue: 0.6, hair: 5, luck: 2 };

/** かわいい層ではない（＝並べるとスキップを閉じる層）か。 */
export const isPlain = (f) => (f.tier ?? 'cute') !== 'cute';

export const tierOf = (f) => f.tier ?? 'cute';

export function choosePair(faces, model, stats, rand = Math.random, keys = KEYS, W = PAIR_WEIGHTS) {
  const n = faces.length;
  if (n < 2) throw new Error('顔のプールが足りません');
  const seen = stats?.seen ?? new Map();
  const count = stats?.count ?? new Map();
  const candidates = Math.min(500, Math.max(80, n * 4));
  let best = null, bestScore = -Infinity;

  for (let t = 0; t < candidates; t++) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * (n - 1));
    if (j >= i) j++;
    const A = faces[i], B = faces[j];
    if (tierOf(A) !== tierOf(B)) continue;
    if (stats?.usedPairs?.has(pairId(A, B))) continue;

    let gain = 0, spread = 0;
    for (const k of keys) {
      const diff = Math.abs(A.v[k] - B.v[k]);
      spread += diff;
      gain += diff / Math.pow(1 + (count.get(k) ?? 0), 0.8);
    }
    // 予測が五分に近いほど情報量が大きい
    const p = model ? predict(model, A.v, B.v, keys) : 0.5;
    const uncertainty = 1 - Math.abs(p - 0.5) * 2;
    // 見飽きた顔は避ける
    const fatigue = (seen.get(A.id) ?? 0) + (seen.get(B.id) ?? 0);

    // 髪の長さが離れた2枚は避ける。
    // gain の項は「まだ観測の薄い特徴で差が大きいペア」を高く評価するので、
    // 放っておくと序盤にロングとベリーショートを並べにいく。そうなると
    // 「顔がどうであれ短い方は選ばない」人の回が顔の判定に化けてしまう。
    // 層のように硬く切ると選べるペアが減って適応の効きが落ちるので、
    // 近いペアを優先しつつ必要なら離れたペアも選べるようにしてある。
    // 順位ではなく実測の長さで測る（features.js の hairOf を参照）。
    // 持っていない顔（合成プールなど）は 0.5 扱いで、減点はほぼ効かない。
    const hairGap = Math.abs((A.hair ?? 0.5) - (B.hair ?? 0.5));

    // luck は回ごとの贔屓。同じくらい効くペアが何通りもあるとき、
    // どれを選ぶかを回ごとに変えて、毎回ちがう顔が出るようにする。
    const luck = luckOf(stats, A.id) + luckOf(stats, B.id);

    const s = W.gain * gain - W.spread * spread + W.unc * uncertainty
      - W.fatigue * fatigue - (W.hair ?? 0) * hairGap
      + (W.luck ?? 0) * luck + rand() * 0.05;
    if (s > bestScore) { bestScore = s; best = [A, B]; }
  }
  // 候補を引き当てられなかったとき（片方の層を引き尽くしたなど）も層はまたがない
  if (!best) best = fallbackPair(faces);
  return rand() < 0.5 ? best : [best[1], best[0]];
}

/** いちばん枚数の多い層から 2 枚。層が取れなければ先頭の 2 枚。 */
function fallbackPair(faces) {
  const byTier = new Map();
  for (const f of faces) {
    const t = tierOf(f);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(f);
  }
  const biggest = [...byTier.values()].sort((a, b) => b.length - a.length)[0];
  return biggest.length >= 2 ? [biggest[0], biggest[1]] : [faces[0], faces[1]];
}

/**
 * この組み合わせが傾向の判定にどれだけ効くか（0..1）。
 * まだ十分見ていない特徴で差が大きく、かつ予測が五分に近いほど高い。
 * 五分に近いということは、どちらを選ぶかで推定が動くということ。
 */
export function pairValue(A, B, model, stats, keys = KEYS) {
  const count = stats?.count ?? new Map();
  let num = 0, den = 0;
  for (const k of keys) {
    const w = 1 / Math.pow(1 + (count.get(k) ?? 0), 0.8);
    num += Math.abs(A.v[k] - B.v[k]) * w;
    den += w;
  }
  const novelty = den ? num / den : 0;
  const p = model ? predict(model, A.v, B.v, keys) : 0.5;
  return novelty * (1 - Math.abs(p - 0.5) * 2);
}

export const pairId = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

/** choosePair 用の統計を更新する */
export function updateStats(stats, A, B, keys = KEYS) {
  stats.seen.set(A.id, (stats.seen.get(A.id) ?? 0) + 1);
  stats.seen.set(B.id, (stats.seen.get(B.id) ?? 0) + 1);
  stats.usedPairs.add(pairId(A, B));
  for (const k of keys) {
    if (Math.abs(A.v[k] - B.v[k]) >= 0.25) stats.count.set(k, (stats.count.get(k) ?? 0) + 1);
  }
}

// 1回ぶんの記録。
// luck は「この回だけ、この顔を贔屓する」ための乱数。
// これがないと、判定に効くペアの選び方が毎回同じ状態から始まるので、
// 序盤は決まった顔ばかり出る。回ごとに贔屓を変えることで、
// 同じくらい判定に効く顔の中から毎回ちがう顔が選ばれる。
//
// 231枚のプールで60回ずつ遊ばせた実測（W.luck を振ったもの）:
//
//   W.luck   出た顔   一度も出ない   1問目の種類   一致率(30問)
//      0      174枚       57枚          44種         0.832
//      1      212枚       19枚          40種         0.823
//      2      224枚        7枚          52種         0.819   ← これを使う
//      4      227枚        4枚          55種         0.814
//      8      230枚        1枚          63種         0.804
//
// 増やすほど顔は散るが精度は落ちる。2 は「顔の97%が使われる」代わりに
// 一致率が1.3ポイント落ちる点。顔を増やしたのに4分の1が一度も出ないのは
// 本末転倒なので、ここを取っている。
/**
 * 推定精度。ランダムな2枚を見せたとき、その人の好みを言い当てられる割合。
 *
 * 結果画面に出していた「ブレの少なさ」は、これとは別物だった。
 * choosePair は「モデルがいちばん自信のないペア」を選んで出題するので、
 * その正答率は問題を増やしても上がらない（15問で70.8%、90問で68.6%）。
 * 難しさが実力と釣り合ったまま動くためで、努力とは無関係な数字になる。
 * 一方こちらは 15問76.3% → 90問89.6% と、ちゃんと上がる。
 *
 * 問数と「出題時の予測がどれだけ当たったか」から見積もる。
 * 仮想ユーザー160人×8時点での最小二乗あてはめ:
 *
 *   使う手がかり            推定の誤差
 *   問数だけ                 7.20pt
 *   問数＋ブレの少なさ        6.14pt
 *   問数＋出題時の的中率      6.64pt   ← これを使う
 *
 * ブレの少なさ（looAccuracy）のほうがわずかに当たるが、毎回 n 回学習し直す
 * ので1問ごとには計算できない。出題時の的中率は数えるだけで済み、
 * 両者の相関は 0.667 ある。
 *
 * 誤差が6.6ポイントあるので、点ではなく幅で見せること。
 */
export const ACC_FIT = { a: 0.5133, b: 0.0736, c: 0.2948, mae: 0.066 };

/** rounds 問答えて、出題時の的中率が preq のときの推定精度（0.5..0.97）。 */
export function estimateAccuracy(rounds, preq) {
  if (!(rounds > 0)) return null;
  const p = Number.isFinite(preq) ? preq : 0.7;
  const v = ACC_FIT.a + ACC_FIT.b * Math.log(rounds) + ACC_FIT.c * (p - 0.5);
  return Math.max(0.5, Math.min(0.97, v));
}

/**
 * 「傾向がはっきりしたか」の判定。回数を決めずに遊ぶモードで使う。
 *
 * 上位3項目の顔ぶれが STABLE 回続けて変わらず、かつ3位と4位の重視度に
 * GAP 以上の差がついたら、それ以上聞いても結果はほぼ動かない。
 *
 * 231枚のプールでの実測（仮想ユーザー400人）:
 *
 *              問数 中央(10%〜90%)   一致率 平均   下位10%
 *   固定30問     30 (30〜30)          0.820      0.728
 *   これ         31 (19〜51)          0.827      0.740
 *
 * 平均の精度はほぼ変わらない。変わるのは長さで、好みがはっきりしている人は
 * 19問で終わり、はっきりしない人には51問まで聞く。
 */
// 目標と、そのときに実際に出る精度・問数（仮想ユーザー180人での実測）:
//
//   目標   上限    問数 中央(10%〜90%)   実際の精度 中央   下位10%
//   80%    50問      36 (22〜50)          82.0%        67.3%
//   82%    60問      45 (31〜60)          84.0%        73.0%   ← これを使う
//   84%    70問      59 (38〜70)          86.8%        73.5%
//   85%    80問      64 (42〜80)          88.3%        80.0%
//
// 掲げた目標と実際はよく合う。上を狙うほど問数が伸びるので、
// 「しっかり(45問)」と同じくらいの長さに収まる 82% を選んでいる。
export const AUTO_STOP = { min: 12, max: 60, stable: 3, gap: 0.05, target: 0.82 };

/** 上位3項目の顔ぶれ（並び順は無視）。 */
const top3Of = (model) => model.keys
  .map((_, i) => i)
  .sort((x, y) => model.importance[y] - model.importance[x])
  .slice(0, 3).sort((x, y) => x - y).join(',');

/**
 * いま終わってよいか。state は { same, prev } を持つ器で、呼ぶたびに更新する。
 * 答えた回数 answered と、いまのモデルを渡す。
 */
export function shouldStop(model, answered, memo, cfg = AUTO_STOP) {
  // 同じ回で二度呼ばれても数えを進めない。
  // 呼ぶ側（次のペアの用意）が1回の回答で二度走ることがある。
  if (memo.at === answered) return memo.stop ?? false;
  memo.at = answered;
  const done = (v) => { memo.stop = v; return v; };

  if (!model) return done(false);
  if (answered >= cfg.max) return done(true);
  if (answered < cfg.min) { memo.prev = null; memo.same = 0; return done(false); }

  // 推定精度が目標に届くまで続ける。
  const est = estimateAccuracy(answered, memo.preq);
  if (est < cfg.target) { memo.prev = null; memo.same = 0; return done(false); }

  // 届いていても、上位3項目がまだ入れ替わっているなら続ける。
  const now = top3Of(model);
  memo.same = (now === memo.prev) ? (memo.same ?? 0) + 1 : 0;
  memo.prev = now;
  const sorted = model.importance.slice().sort((a, b) => b - a);
  const gap = sorted[2] > 0 ? (sorted[2] - sorted[3]) / sorted[2] : 0;
  return done(memo.same >= cfg.stable && gap >= cfg.gap);
}

export const newStats = (rand = Math.random) => ({
  seen: new Map(), count: new Map(), usedPairs: new Set(),
  luck: new Map(), rand,
});

/** その回かぎりの顔ごとの贔屓（0..1）。初めて見る顔のぶんだけ作る。 */
function luckOf(stats, id) {
  if (!stats?.luck) return 0.5;
  let v = stats.luck.get(id);
  if (v === undefined) { v = (stats.rand ?? Math.random)(); stats.luck.set(id, v); }
  return v;
}
