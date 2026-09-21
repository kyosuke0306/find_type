// 画面遷移と診断の進行。推定そのものは model.js、特徴の定義は features.js にある。

import { FEATURES, KEYS, FACE_KEYS, LOOK_KEYS, normalizePool, cuteScore, measurableKeys } from './features.js';
import { partShares } from './facemap.js';
import { fit, choosePair, updateStats, newStats, score, looAccuracy, pairValue, isPlain, shouldStop, AUTO_STOP } from './model.js';
import { icon, featureIcon } from './icons.js';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = true; });
  $(id).hidden = false;
  window.scrollTo(0, 0);
};

const STORE_KEY = 'find-type/last-result';
const MIN_FACES = 12;  // 1回の診断に必要な最小の顔数
// ?data=... で同梱プールを差し替えられる（動作確認用のダミープールなど）
const DATA = (new URLSearchParams(location.search).get('data') ?? 'data').replace(/\/+$/, '');

const state = {
  pool: [],          // 顔プール（正規化済み）
  byId: new Map(),
  faces: [],         // 今回使う性別に絞ったもの
  gender: 'female',
  rounds: 30,
  round: 0,          // 答えた回数（スキップは数えない）
  shown: 0,          // 出したペアの数（無限に続かないようにするため）
  pair: null,
  next: null,        // 先に決めて読み込んでおいた次のペア
  locked: false,     // 判定に効く組み合わせ（スキップ不可）
  history: [],       // { a, b, winner, skipped }
  stats: newStats(),
  model: null,
  busy: false,
  autoMemo: {},      // 「はっきりしたら終わり」の判定に使う（src/model.js の shouldStop）
};

/* ---------------- 起動 ---------------- */
init();

async function init() {
  try {
    await reloadPool();
  } catch (e) {
    return showSetupNeeded(e.message);
  }
  if (state.pool.length < MIN_FACES) {
    return showSetupNeeded(`顔画像が ${state.pool.length} 枚しかありません。${MIN_FACES}枚以上必要です。`);
  }
  buildStartScreen();
  show('screen-start');
}

function showSetupNeeded(reason) {
  $('setup-reason').textContent = reason;
  show('screen-setup-needed');
}

/** 顔プールを読み込んで、プール内での相対値に正規化する */
async function reloadPool() {
  const bundled = await loadBundled();
  state.pool = normalizePool(bundled);
  state.byId = new Map(state.pool.map((f) => [f.id, f]));
  // 顔どうしの差が小さすぎる項目は、結果で言い切らない
  state.usable = measurableKeys(bundled);
}

async function loadBundled() {
  const res = await fetch(`${DATA}/faces.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${DATA}/faces.json を読み込めません (HTTP ${res.status})`);
  const json = await res.json();
  return (json.faces ?? []).map((f) => ({ ...f, src: `${DATA}/faces/${f.file}` }));
}

/* ---------------- スタート画面 ---------------- */
function buildStartScreen() {
  const counts = state.pool.reduce((m, f) => (m[f.gender] = (m[f.gender] ?? 0) + 1, m), {});
  const nFemale = counts.female ?? 0, nMale = counts.male ?? 0;
  const options = [
    { value: 'female', label: '女性', ic: 'female' },
    { value: 'male', label: '男性', ic: 'male' },
  ].filter((o) => (o.value === 'female' ? nFemale : nMale) >= MIN_FACES);
  // 「両方」は両方の性別が単独で足りているときだけ意味がある
  if (nFemale >= MIN_FACES && nMale >= MIN_FACES) {
    options.push({ value: 'all', label: '両方', ic: 'both' });
  } else if (!options.length) {
    options.push({ value: 'all', label: 'すべて', ic: 'both' });
  }
  state.gender = options[0].value;

  // 選べる性別が1つしかないなら、選択肢を出す意味がないので隠す
  const genderBox = $('gender-choices');
  genderBox.hidden = options.length < 2;
  genderBox.innerHTML = options.length < 2 ? '' : options.map((o, i) =>
    `<button class="choice${i === 0 ? ' is-on' : ''}" data-value="${o.value}">
       ${icon(o.ic)}<span>${o.label}</span>
     </button>`).join('');
  if (options.length >= 2) bindChoices(genderBox, (v) => { state.gender = v; });

  $('rounds-choices').innerHTML = [
    // 同梱プールでの実測値。npm run acc-check で確かめられる。
    // 顔・較正・ペアの選び方・測る項目のどれかを変えると動くので、
    // 公開する前に必ず確かめること（CLAUDE.md を参照）。
    { v: 20, label: 'さくっと', acc: 79 },
    { v: 30, label: 'おすすめ', acc: 82 },
    { v: 45, label: 'しっかり', acc: 85 },
    { v: 90, label: 'とことん', acc: 89 },
  ].map((r) => `<button class="choice${r.v === state.rounds ? ' is-on' : ''}" data-value="${r.v}">
      <span class="big">${r.v}</span><span class="sub">${r.label}</span>
      <span class="acc">精度 ${r.acc}%</span></button>`).join('')
    // 回数を決めないモードは種類が違う選択肢なので、数字と同じ列に並べず
    // 下に横幅いっぱいで置く。5つ横並びにすると文字が折り返して読めない。
    // 平均の精度は固定30問とほぼ同じで、長さが人によって変わる（19〜51問）。
    + `<button class="choice choice-wide${state.rounds === 'auto' ? ' is-on' : ''}" data-value="auto">
      <span class="big">おまかせ</span>
      <span class="acc">はっきりするまで · 19〜51問</span></button>`;

  // 'auto' は数に直さない。回数を決めないモードの目印として文字のまま持つ。
  bindChoices($('rounds-choices'), (v) => { state.rounds = v === 'auto' ? 'auto' : Number(v); });

  $('btn-start').innerHTML = `${icon('play')}<span>はじめる</span>`;
  $('btn-start').onclick = startSession;

  const last = localStorage.getItem(STORE_KEY);
  $('btn-last-result').hidden = !last;
  $('btn-last-result').innerHTML = `${icon('chart')}<span>前回の結果</span>`;
  $('btn-last-result').onclick = () => {
    try { renderResult(JSON.parse(last)); show('screen-result'); }
    catch { localStorage.removeItem(STORE_KEY); }
  };
}

function bindChoices(box, onPick) {
  box.onclick = (e) => {
    const b = e.target.closest('.choice');
    if (!b) return;
    box.querySelectorAll('.choice').forEach((c) => c.classList.remove('is-on'));
    b.classList.add('is-on');
    onPick(b.dataset.value);
  };
}

/* ---------------- 診断の進行 ---------------- */
function startSession() {
  state.faces = state.gender === 'all' ? state.pool : state.pool.filter((f) => f.gender === state.gender);
  state.round = 0;
  state.shown = 0;
  state.history = [];
  state.stats = newStats();
  state.model = null;
  state.next = null;
  state.autoMemo = {};
  show('screen-play');
  nextRound();
}

// 選んだあとの演出の長さ。この間に次の顔を読み込む。
const PICK_MS = 420;

// この値を超える組み合わせはスキップさせない。
// 判定が動く場面で飛ばされると、その分だけ結果の裏づけが薄くなる。
// 45問のうち2割ほどが該当する（test/simulate.mjs で分布を見て決めた）。
const SKIP_LOCK = 0.38;

// 次に出すペアを決める。序盤はモデルが当てにならないので、
// 推定を使い始めるのは数回たってから。
function decidePair() {
  const model = state.history.length >= 6 ? state.model : null;
  return choosePair(state.faces, model, state.stats);
}

// 画像が実際に表示できる状態になるまで待つ。読み込み済みならすぐ返る。
function loadFace(f) {
  const img = new Image();
  img.src = f.src;
  if (img.decode) return img.decode().catch(() => {});
  return img.complete ? Promise.resolve() : new Promise((done) => { img.onload = img.onerror = done; });
}

// 「おまかせ」のときの回数の目安。進み具合の表示と、スキップの上限に使う。
const AUTO_TYPICAL = 31;

/** もう終わってよいか。回数を決めたときは残り回数で、おまかせは傾向の固まり具合で決める。 */
function sessionDone() {
  if (state.rounds === 'auto') {
    if (state.shown >= AUTO_STOP.max * 3) return true;   // スキップが続いても終わる
    return shouldStop(state.model, state.round, state.autoMemo);
  }
  return state.round >= state.rounds || state.shown >= state.rounds * 3;
}

// 次のペアを決めて先に読み込んでおく。終わっていれば決めない。
function prepareNext() {
  if (sessionDone()) {
    state.next = null;
    return Promise.resolve();
  }
  state.next = decidePair();
  return Promise.all(state.next.map(loadFace));
}

function nextRound() {
  if (!state.next) prepareNext();
  if (!state.next) return finishSession();
  state.shown++;
  state.pair = state.next;
  state.next = null;
  return showPair();
}

async function showPair() {
  const [a, b] = state.pair;
  const arena = $('arena');
  // 読み込みが終わるまで古い顔を残さない。残したままだと、
  // 切り替わる前の顔を見て選んでしまう。
  // 先読みが効いていればこの状態は1フレームも表示されない。
  arena.classList.add('is-loading');
  state.busy = true;
  const cards = document.querySelectorAll('.face-card');
  // 選んだあとの見た目を読み込み中まで引きずらないよう、先に戻す
  cards.forEach((c) => c.classList.remove('is-picked', 'is-dropped'));
  if (state.rounds === 'auto') {
    // 終わりが決まっていないので「◯問目」とだけ出す。
    // 進み具合は、上位3つが何回続けて同じだったかで見せる。
    // ここが伸びているときは終わりが近い、と伝わるようにしてある。
    $('round-label').textContent = `${state.round + 1} 問目`;
    const settled = (state.autoMemo.same ?? 0) / AUTO_STOP.stable;
    const along = state.round / AUTO_TYPICAL;
    $('progress-fill').style.width = `${Math.min(100, Math.max(settled, along) * 100)}%`;
  } else {
    $('round-label').textContent = `${state.round + 1} / ${state.rounds}`;
    $('progress-fill').style.width = `${(state.round / state.rounds) * 100}%`;
  }
  $('btn-undo').disabled = state.history.length === 0;

  // 判定に効く組み合わせではスキップを閉じる。
  // 推定が始まる前は「効く組み合わせ」を判断できないので閉じない。
  const model = state.history.filter((h) => !h.skipped).length >= 6 ? state.model : null;
  // かわいい層以外の回は必ず閉じる。
  // 飛ばされやすい回なのに、顔のパーツの幅がいちばん広いのがこの層なので、
  // 飛ばされるとこの層を入れた意味がなくなる（test/simulate.mjs で確認した）。
  const plain = isPlain(a) && isPlain(b);
  state.locked = plain || (!!model && pairValue(a, b, model, state.stats) >= SKIP_LOCK);
  $('btn-skip').disabled = state.locked;
  $('skip-lock').hidden = !state.locked;
  arena.classList.toggle('is-locked', state.locked);

  const img0 = $('img-0'), img1 = $('img-1');
  img0.src = a.src;
  img1.src = b.src;
  await Promise.all([img0, img1].map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));

  // 入場アニメーションをやり直させる
  cards.forEach((c) => { c.style.animation = 'none'; void c.offsetWidth; c.style.animation = ''; });
  arena.classList.remove('is-loading');
  state.busy = false;
}

function choose(side) {
  if (state.busy || !state.pair) return;
  const [a, b] = state.pair;
  const win = side === 0 ? a : b;
  const cards = document.querySelectorAll('.face-card');
  cards[side].classList.add('is-picked');
  cards[1 - side].classList.add('is-dropped');
  state.busy = true;

  state.history.push({ a, b, winner: win.id, skipped: false });
  updateStats(state.stats, a, b);
  state.round++;
  // 選択が増えるたび再推定し、次のペア選びに反映する
  if (state.history.length >= 6) state.model = fit(comparisons());

  // 演出を見せている間に次の顔を読み込む。両方そろってから切り替える。
  const warm = prepareNext();
  const anim = new Promise((done) => setTimeout(done, PICK_MS));
  Promise.all([anim, warm]).then(() => {
    state.busy = false;
    nextRound();
  });
}

function skip() {
  if (state.busy || state.locked || !state.pair) return;
  const [a, b] = state.pair;
  // スキップは好みの情報にならないので記録せず、回数にも数えない。
  // 数えてしまうと、画面に出している精度（答えた回数に対する値）より
  // 実際の精度が低くなってしまう。同じ組は再提示しない。
  state.stats.usedPairs.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  state.history.push({ a, b, winner: null, skipped: true });
  nextRound();
}

function undo() {
  if (state.busy) return;
  const last = state.history.pop();
  if (!last) return;
  if (!last.skipped) state.round = Math.max(0, state.round - 1);
  state.shown = Math.max(0, state.shown - 1);
  // 統計は作り直す（戻した分を確実に消すため）
  state.stats = newStats();
  for (const h of state.history) {
    if (h.skipped) state.stats.usedPairs.add(h.a.id < h.b.id ? `${h.a.id}|${h.b.id}` : `${h.b.id}|${h.a.id}`);
    else updateStats(state.stats, h.a, h.b);
  }
  state.model = state.history.filter((h) => !h.skipped).length >= 6 ? fit(comparisons()) : null;
  // 「はっきりしたか」の数えも戻す。戻した回の分を数えたままだと、
  // 戻ったのに終わってしまう。
  state.autoMemo = {};
  state.next = null;
  state.pair = [last.a, last.b];
  showPair();
}

const comparisons = () => state.history.filter((h) => !h.skipped).map((h) => {
  const win = h.winner === h.a.id ? h.a : h.b;
  const lose = h.winner === h.a.id ? h.b : h.a;
  return { win: win.v, lose: lose.v };
});

/* ---------------- 結果 ---------------- */
async function finishSession() {
  // 集計は重く、その間ブラウザは何も描けない。
  // 先に読み込み表示を出し、実際に描かれてから計算を始める。
  $('arena').classList.add('is-loading');
  $('arena').classList.remove('is-locked');
  $('btn-skip').disabled = true;
  $('skip-lock').hidden = true;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

  const cs = comparisons();
  if (cs.length < 6) {
    $('arena').classList.remove('is-loading');
    alert('スキップが多く、判定できるだけの選択が集まりませんでした。もう一度お試しください。');
    show('screen-start');
    return;
  }
  const model = fit(cs);
  const loo = looAccuracy(cs);

  // かわいい層からだけ選ぶ。
  // それ以外の層は「その人の好みを測る」ために入れてあるだけで、
  // 「あなたの好みの顔はこれです」として見せるためのものではない。
  const shown = state.faces.filter((f) => !isPlain(f));
  const ranked = [...(shown.length >= 3 ? shown : state.faces)]
    .sort((x, y) => score(model, y.v) - score(model, x.v));
  const payload = {
    at: new Date().toISOString(),
    gender: state.gender,
    rounds: cs.length,
    skipped: state.history.length - cs.length,
    m: model.m, importance: model.importance, support: model.support,
    loo, trainAccuracy: model.trainAccuracy,
    poolSize: state.faces.length,
    usable: [...state.usable],
    top: ranked.slice(0, 3).map((f) => f.id),
    chosen: state.history.filter((h) => !h.skipped).map((h) => h.winner),
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch { /* 容量超過は無視 */ }
  $('arena').classList.remove('is-loading');
  renderResult(payload);
  startStory(payload);
}

/* ===== 結果を1枚ずつめくって見せる ===== */

/**
 * スライドの内容を組み立てる。
 *
 * 数字をいきなり全部出すより、1つずつ開けていくほうが見ていて楽しい。
 * いちばんの見どころ（好みに近い顔）は最後に取っておく。
 */
function buildSlides(r) {
  const can = usableOf(r);
  const share = faceShares(r);
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  const faceOrder = order.filter((i) => can.has(KEYS[i]) && FACE_KEYS.includes(KEYS[i]));
  const parts = partShares(r.importance, can);
  const { score, basis } = cuteScore(r.m, r.importance, can);
  const vague = basis < 0.35 || Math.abs(score) < 0.12;
  const pct = Math.round((r.loo ?? r.trainAccuracy) * 100);
  const srcOf = (id) => state.byId.get(id)?.src ?? '';
  const top1 = faceOrder[0];
  const f1 = top1 !== undefined ? FEATURES[top1] : null;
  const side1 = f1 ? (r.m[top1] > 0.62 ? f1.highTag : r.m[top1] < 0.38 ? f1.lowTag : `中間の${f1.name}`) : null;

  const slides = [];

  slides.push({
    cls: 'st-open',
    html: `<p class="st-kicker">${r.rounds}回の選択を読みました</p>
      <h2 class="st-big">結果が<br>出ました</h2>
      <p class="st-sub">何を見ていたのか、順番に見ていきます</p>`,
  });

  if (parts.length) {
    slides.push({
      cls: 'st-parts',
      html: `<p class="st-kicker">まず、顔のどこを見ていたか</p>
        <h2 class="st-lead">いちばん見ていたのは<br><b>${parts[0].name}</b>でした</h2>
        <ul class="st-bars">${parts.slice(0, 4).map((p, n) => `
          <li style="--i:${n}"><span>${p.name}</span>
            <i class="st-bar"><b data-w="${(p.share / parts[0].share) * 100}%"></b></i>
            <em>${Math.round(p.share * 100)}%</em></li>`).join('')}</ul>`,
    });
  }

  if (f1) {
    slides.push({
      cls: 'st-feat',
      html: `<p class="st-kicker">もっとこまかく見ると</p>
        <h2 class="st-lead"><b>${f1.name}</b>が<br>${Math.round(share(top1) * 100)}%を<br>占めていました</h2>
        <div class="st-axis">
          <span>${f1.lowTag}</span>
          <i class="st-track"><b data-left="${r.m[top1] * 100}%"></b></i>
          <span>${f1.highTag}</span>
        </div>
        <p class="st-sub">あなたが好きなのは<b>${side1}</b>です</p>`,
    });
  }

  // 見出しは判定だけにする。強さを同じ行に足すと、狭い画面で
  // 最後の1〜2文字だけ次の行に落ちて間が抜ける。
  const styleWord = score > 0 ? 'かわいい系' : 'きれい系';
  slides.push({
    cls: 'st-style',
    html: `<p class="st-kicker">では、どんな系統か</p>
      <h2 class="st-lead">${vague ? 'きれい系も<br>かわいい系も<br><b>同じくらい</b>'
        : `あなたは<br><b class="${score > 0 ? 'is-cute' : ''}">${styleWord}</b>`}</h2>
      <div class="st-scale"><span>きれい系</span>
        <i class="st-track"><b data-left="${((score + 1) / 2) * 100}%" class="${vague ? '' : score > 0 ? 'is-cute' : ''}"></b></i>
        <span>かわいい系</span></div>
      <p class="st-sub">${vague ? '系統より、個々のパーツを見ているようです'
        : Math.abs(score) >= 0.45 ? 'はっきりと出ています' : 'どちらかといえば、です'}</p>`,
  });

  slides.push({
    cls: 'st-consist',
    html: `<p class="st-kicker">選び方のブレは</p>
      <h2 class="st-big"><span class="st-num" data-num="${pct}">0%</span></h2>
      <p class="st-lead">${pct >= 85 ? '好みが<b>はっきり</b>しています'
        : pct >= 72 ? '好みは<b>一貫</b>しています'
        : pct >= 60 ? '<b>ややブレ</b>がありました'
        : '<b>気分で選んで</b>いたようです'}</p>`,
  });

  const tops = r.top.filter((id) => srcOf(id));
  if (tops.length) {
    slides.push({
      cls: 'st-faces',
      html: `<p class="st-kicker">お待たせしました</p>
        <h2 class="st-lead">あなたの好みに<br>いちばん近い顔は</h2>
        <div class="st-face-wrap"><img src="${srcOf(tops[0])}" alt="好みに近い顔 1位"></div>
        <p class="st-sub">${typePhrase(r)}</p>`,
    });
  }

  slides.push({
    cls: 'st-end',
    html: `<h2 class="st-big">${typePhrase(r)}</h2>
      <p class="st-sub">タップして、ぜんぶの結果を見る</p>`,
  });

  return slides;
}

/** スライドを開始する */
function startStory(r) {
  const slides = buildSlides(r);
  let at = -1;
  const stage = $('story-stage');
  $('story-progress').innerHTML = slides.map(() => '<i></i>').join('');
  const dots = [...$('story-progress').children];

  const next = () => {
    at++;
    if (at >= slides.length) { show('screen-result'); return; }
    dots.forEach((d, i) => d.classList.toggle('is-on', i <= at));
    const s = slides[at];
    stage.innerHTML = `<div class="st-slide ${s.cls}">${s.html}</div>`;
    $('story-hint').textContent = at === slides.length - 1 ? 'タップでまとめへ' : 'タップで次へ';
    // 描画してから動かす
    requestAnimationFrame(() => {
      stage.querySelectorAll('.st-bar b').forEach((el) => { el.style.width = el.dataset.w; });
      stage.querySelectorAll('.st-track b').forEach((el) => { el.style.left = el.dataset.left; });
      const num = stage.querySelector('.st-num');
      if (num) countUp(num, Number(num.dataset.num), 900);
    });
  };

  const onTap = (e) => { if (e.target.closest('#story-skip')) return; next(); };
  $('screen-story').onclick = onTap;
  $('story-skip').onclick = () => show('screen-result');
  next();
  show('screen-story');
}

/** 結果で言い切ってよい項目か（古い保存結果には情報がないので全部通す） */
const usableOf = (r) => (r.usable ? new Set(r.usable) : new Set(KEYS));

/**
 * 顔の項目だけを分母にした重視度の割合。
 *
 * 画面のどこでもこれを使う。以前はタグが15項目すべて、内訳が顔の12項目、
 * 部位のまとめがまた別、と分母が3通りあり、同じ項目が 37% と 46% の
 * 2通りで出ていた。分母をそろえると、部位の % は内訳の % の合計になる。
 */
function faceShares(r) {
  const can = usableOf(r);
  const total = FACE_KEYS.reduce((s, k) => s + (can.has(k) ? r.importance[KEYS.indexOf(k)] : 0), 0) || 1;
  return (i) => (can.has(KEYS[i]) ? r.importance[i] / total : 0);
}

/** 効いていた顔のパーツを、重視度の高い順に返す（見出しと式で共用） */
function topTags(r, limit) {
  const usable = usableOf(r);
  const share = faceShares(r);
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  const tags = [];
  for (const i of order) {
    if (tags.length >= limit) break;
    if (!usable.has(KEYS[i]) || !FACE_KEYS.includes(KEYS[i])) continue;
    if (share(i) < 0.12 || (r.support?.[i] ?? 0) < 3) continue;
    const f = FEATURES[i], m = r.m[i];
    tags.push(m > 0.62 ? f.highTag : m < 0.38 ? f.lowTag : `中間の${f.name}`);
  }
  return tags;
}

/**
 * 顔のタイプを一言で言う。
 *
 * いちばん効いていたパーツに、きれい系／かわいい系の判定を添えるだけにする。
 * 内訳は下の「×」の式とタグが受け持つので、ここは短さを優先する。
 * 系統は言い切れる根拠があるときだけ足す（renderStyle と同じ条件）。
 */
function typePhrase(r) {
  const tags = topTags(r, 1);
  const { score, basis } = cuteScore(r.m, r.importance, usableOf(r));
  const style = Math.abs(score) >= 0.12 && basis >= 0.35
    ? (score > 0 ? 'かわいい系' : 'きれい系') : null;
  if (!tags.length) return style ? `${style}タイプ` : '雰囲気で選ぶタイプ';
  return style ? `${tags[0]}の${style}タイプ` : `${tags[0]}タイプ`;
}

/** 効いていたパーツを掛け算の形で並べる（見出しの内訳） */
function typeFormula(r) {
  const tags = topTags(r, 3);
  return tags.length ? tags.join(' × ') : '顔のパーツにはこだわり少なめ';
}

function renderResult(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  $('result-title').textContent = typePhrase(r);
  $('result-formula').textContent = typeFormula(r);

  // 上位項目をタグで見せる（説明文の代わり）。
  // 重視度がほぼ0の項目を並べても意味がないので、目立つものだけ出す。
  const usable = usableOf(r);
  const share = faceShares(r);
  const isFace = (i) => usable.has(KEYS[i]) && FACE_KEYS.includes(KEYS[i]);
  const shown = order.filter((i) => isFace(i) && share(i) >= 0.08).slice(0, 3);
  const fallback = order.filter(isFace).slice(0, 1);
  $('result-tags').innerHTML = (shown.length ? shown : fallback).map((i, n) =>
    `<span class="tag" style="--i:${n}">${featureIcon(KEYS[i])}${FEATURES[i].name}
       <b>${Math.round(share(i) * 100)}%</b></span>`).join('');

  $('t-top').innerHTML = `${icon('crown')}好みに近い顔`;
  $('t-style').innerHTML = `${icon('sparkle')}きれい系 or かわいい系`;
  $('t-feat').innerHTML = `${icon('chart')}見ていたところ`;
  $('t-look').innerHTML = `${featureIcon('hairLength')}髪と肌`;
  $('t-chosen').innerHTML = `${icon('heart', { cls: 'is-heart' })}選んだ顔 <span class="card-note">${r.chosen.length}枚</span>`;

  const srcOf = (id) => state.byId.get(id)?.src ?? '';
  $('top-faces').innerHTML = r.top.filter((id) => srcOf(id)).map((id, i) => `
    <figure><img src="${srcOf(id)}" alt="好みに近い顔 ${i + 1}位" loading="lazy">
    <span class="rank">${i + 1}</span></figure>`).join('');

  renderStyle(r);
  renderFaceMap(r);
  renderFeatures(r);

  const pct = Math.round((r.loo ?? r.trainAccuracy) * 100);
  $('consistency-label').textContent = pct >= 85 ? '好みがはっきりしています'
    : pct >= 72 ? '好みは一貫しています'
    : pct >= 60 ? 'ややブレがあります'
    : '気分で選んでいるかも';

  $('chosen-strip').innerHTML = r.chosen.filter((id) => srcOf(id))
    .map((id) => `<img src="${srcOf(id)}" alt="" loading="lazy">`).join('');

  $('btn-again').innerHTML = `${icon('replay')}<span>もう一度</span>`;
  $('btn-again').onclick = () => { buildStartScreen(); show('screen-start'); };
  $('btn-copy').innerHTML = `${icon('copy')}<span>結果をコピー</span>`;
  $('btn-copy').onclick = () => copyResult(r);

  // 描画が終わってからバー・ゲージ・数値を動かす
  requestAnimationFrame(() => {
    document.querySelectorAll('.feat-fill, .fm-fill').forEach((el) => { el.style.width = el.dataset.w; });
    document.querySelectorAll('.marker, .style-marker').forEach((el) => { el.style.left = el.dataset.left; });
    $('gauge-fill').style.strokeDashoffset = String(264 - 264 * (pct / 100));
    countUp($('consistency-num'), pct);
  });
}

/** 数値を 0 から目標値まで数え上げる */
function countUp(el, target, ms = 1100) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = `${Math.round(target * eased)}%`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** きれい系 ⇔ かわいい系 のどちらに寄っているか */
function renderStyle(r) {
  const { score, basis, top } = cuteScore(r.m, r.importance, usableOf(r));
  const cute = score > 0;
  const strength = Math.abs(score);
  // 根拠が薄いとき（髪や肌ばかり見ている人）は言い切らない
  const vague = basis < 0.35 || strength < 0.12;
  const word = cute ? 'かわいい系' : 'きれい系';
  $('style-verdict').innerHTML = vague
    ? 'どちらも同じくらい'
    : `${strength >= 0.45 ? 'はっきり' : 'どちらかといえば'}<b>${word}</b>`;
  $('style-verdict').classList.toggle('is-vague', vague);
  $('style-verdict').classList.toggle('is-cute', !vague && cute);
  $('style-note').textContent = vague
    ? '系統で選ぶより、個々のパーツを見ているようです'
    : `${top.slice(0, 2).map((i) => FEATURES[i].name).join('と')}にあらわれています`;
  const marker = $('style-marker');
  marker.dataset.left = `${((score + 1) / 2) * 100}%`;
  marker.classList.toggle('is-vague', vague);
  marker.classList.toggle('is-cute', !vague && cute);
}

/** 顔のどこを見て決めているか。顔の絵とパーツ別の割合で見せる */
function renderFaceMap(r) {
  const shares = partShares(r.importance, usableOf(r));
  $('facemap-list').innerHTML = shares.map((p, n) => `
    <li style="--i:${n}">
      <span class="fm-name">${p.name}</span>
      <span class="fm-bar"><i class="fm-fill" data-w="${(p.share / Math.max(shares[0].share, 1e-6)) * 100}%"></i></span>
      <span class="fm-pct">${Math.round(p.share * 100)}%</span>
    </li>`).join('');
}

function renderFeatures(r) {
  const can = usableOf(r);
  const share = faceShares(r);

  const order = FACE_KEYS.map((k) => KEYS.indexOf(k)).sort((a, b) => {
    const ua = can.has(KEYS[a]) ? 1 : 0, ub = can.has(KEYS[b]) ? 1 : 0;
    if (ua !== ub) return ub - ua;           // 判定できる項目を先に
    return r.importance[b] - r.importance[a];
  });
  const max = Math.max(...order.map((i) => (can.has(KEYS[i]) ? share(i) : 0)), 1e-6);
  // 5% と 4% の差は読み取れない（測定でも確からしさは 6〜8割）。
  // 意味のある差がある上位だけ出し、残りは「くわしく見る」に送る。
  const strong = order.filter((i) => can.has(KEYS[i]) && share(i) >= 0.10);
  const nStrong = Math.min(Math.max(strong.length, 2), 3);
  $('feat-lead').textContent = nStrong
    ? `とくに${FEATURES[order[0]].name}を見ていました`
    : '';

  const row = (i, n) => {
    const f = FEATURES[i], m = r.m[i], v = share(i);
    // 同梱の顔どうしで差が小さい項目は、値が出ても根拠がない。
    // 隠さずに「判定できない」と書いて区別する。
    if (!can.has(f.key)) {
      return `<div class="feat is-unmeasurable" style="--i:${n}">
        <div class="feat-head">
          ${featureIcon(f.key)}
          <span class="feat-name">${f.name}</span>
          <span class="feat-note">判定できません</span>
        </div>
        <p class="card-note">同梱の顔どうしで差が小さく、好みを読み取れません</p>
      </div>`;
    }
    return `<div class="feat${v < 0.05 ? ' is-weak' : ''}" style="--i:${n}">
      <div class="feat-head">
        ${featureIcon(f.key)}
        <span class="feat-name">${f.name}</span>
        <span class="feat-pct">${Math.round(v * 100)}%</span>
      </div>
      <div class="feat-bar"><div class="feat-fill" data-w="${(v / max) * 100}%"></div></div>
      <div class="axis">
        <span class="pole low">${f.lowTag}</span>
        <div class="track"><span class="marker" data-left="${m * 100}%"></span></div>
        <span class="pole high">${f.highTag}</span>
      </div>
    </div>`;
  };

  $('feature-list').innerHTML = order.slice(0, nStrong).map(row).join('');
  const btn = $('btn-show-rest');
  btn.hidden = order.length <= nStrong;
  btn.onclick = () => {
    $('feature-list').innerHTML = order.map(row).join('');
    btn.hidden = true;
    replay();
  };

  renderLook(r, can);
}

/** 髪と肌。顔のパーツとは別扱いにする */
function renderLook(r, can) {
  // 顔の項目と髪・肌は別の群として、それぞれの中での割合で出す。
  // 混ぜた分母で並べると、顔の 35% と髪の 7% が比べられるように見えて誤解を生む。
  // 群どうしの大きさは、下の一文（全体の何%が髪と肌か）が受け持つ。
  const all = r.importance.reduce((s, x) => s + x, 0) || 1;
  const lookTotal = LOOK_KEYS.reduce((s, k) => s + (can.has(k) ? r.importance[KEYS.indexOf(k)] : 0), 0);
  const pct = Math.round((lookTotal / all) * 100);
  const lookShare = (i) => (can.has(KEYS[i]) ? r.importance[i] / (lookTotal || 1) : 0);
  $('look-note').textContent = pct >= 50
    ? `顔のパーツより、髪と肌のほうを見て選んでいます（全体の ${pct}%）`
    : `選ぶときの ${pct}% は髪と肌で決まっていました`;

  const lookMax = Math.max(...LOOK_KEYS.map((k) => (can.has(k) ? r.importance[KEYS.indexOf(k)] : 0)), 1e-6);
  $('look-list').innerHTML = LOOK_KEYS
    .map((k) => KEYS.indexOf(k))
    .sort((a, b) => r.importance[b] - r.importance[a])
    .map((i, n) => {
      const f = FEATURES[i], m = r.m[i], imp = r.importance[i];
      if (!can.has(f.key)) {
        return `<div class="feat is-unmeasurable" style="--i:${n}">
          <div class="feat-head">${featureIcon(f.key)}<span class="feat-name">${f.name}</span>
          <span class="feat-note">判定できません</span></div></div>`;
      }
      return `<div class="feat" style="--i:${n}">
        <div class="feat-head">
          ${featureIcon(f.key)}
          <span class="feat-name">${f.name}</span>
          <span class="feat-pct">${Math.round(lookShare(i) * 100)}%</span>
        </div>
        <div class="feat-bar"><div class="feat-fill" data-w="${(imp / lookMax) * 100}%"></div></div>
        <div class="axis">
          <span class="pole low">${f.lowTag}</span>
          <div class="track"><span class="marker" data-left="${m * 100}%"></span></div>
          <span class="pole high">${f.highTag}</span>
        </div>
      </div>`;
    }).join('');
}

/** バーとマーカーを動かす */
function replay() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.feat-fill, .fm-fill').forEach((el) => { el.style.width = el.dataset.w; });
    document.querySelectorAll('.marker, .style-marker').forEach((el) => { el.style.left = el.dataset.left; });
  });
}


async function copyResult(r) {
  const usable = usableOf(r);
  const all = r.importance.reduce((s, x) => s + x, 0) || 1;
  const order = KEYS.map((_, i) => i)
    .filter((i) => usable.has(KEYS[i]) && FACE_KEYS.includes(KEYS[i]))
    .sort((a, b) => r.importance[b] - r.importance[a]).slice(0, 3);
  const lookPct = Math.round(LOOK_KEYS.reduce((s, k) => s + r.importance[KEYS.indexOf(k)], 0) / all * 100);
  const { score, basis } = cuteScore(r.m, r.importance, usable);
  const style = basis < 0.35 || Math.abs(score) < 0.12 ? 'どちらも同じくらい'
    : `${Math.abs(score) >= 0.45 ? 'はっきり' : 'どちらかといえば'}${score > 0 ? 'かわいい系' : 'きれい系'}`;
  const parts = partShares(r.importance, usable).slice(0, 3);
  const text = [
    '【顔の好み診断】',
    `私のタイプ → ${typePhrase(r)}`,
    `内訳 → ${typeFormula(r)}`,
    `系統 → ${style}`,
    `よく見ている → ${parts.map((p) => `${p.name} ${Math.round(p.share * 100)}%`).join(' / ')}`,
    order.map((i) => `${FEATURES[i].name} ${Math.round(faceShares(r)(i) * 100)}%`).join(' / '),
    `髪と肌 ${lookPct}%`,
    `一貫性 ${Math.round((r.loo ?? r.trainAccuracy) * 100)}%（${r.rounds}回）`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('btn-copy').innerHTML = `${icon('check')}<span>コピーしました</span>`;
  } catch {
    $('btn-copy').innerHTML = `<span>コピーできませんでした</span>`;
  }
  setTimeout(() => { $('btn-copy').innerHTML = `${icon('copy')}<span>結果をコピー</span>`; }, 1800);
}

/* ---------------- 入力 ---------------- */
$('vs').textContent = 'VS';
document.querySelectorAll('.burst').forEach((b) => { b.innerHTML = icon('heartFill', { cls: 'is-heart' }); });
$('btn-undo').innerHTML = icon('undo');
$('btn-skip').innerHTML = `${icon('skip')}<span>どちらもピンとこない</span>`;
document.querySelectorAll('.face-card').forEach((card) => {
  card.addEventListener('click', () => {
    // タップで得たフォーカスを残さない。次の組で選択済みのように見えてしまう。
    card.blur();
    choose(Number(card.dataset.side));
  });
});
$('btn-skip').onclick = skip;
$('btn-undo').onclick = undo;

document.addEventListener('keydown', (e) => {
  if ($('screen-play').hidden) return;
  if (e.key === 'ArrowLeft' || e.key === '1') { e.preventDefault(); choose(0); }
  else if (e.key === 'ArrowRight' || e.key === '2') { e.preventDefault(); choose(1); }
  else if (e.key === ' ') { e.preventDefault(); skip(); }
  else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
});
