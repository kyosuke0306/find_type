// 画面遷移と診断の進行。推定そのものは model.js、特徴の定義は features.js にある。

import { FEATURES, KEYS, FACE_KEYS, LOOK_KEYS, normalizePool, cuteScore, measurableKeys } from './features.js';
import { partShares } from './facemap.js';
import { BadKey, buildIdealPrompt, describeIdeal, generateIdeal, PRICE_YEN } from './ideal.js';
import { fit, choosePair, updateStats, newStats, score, looAccuracy, pairValue, isPlain, shouldStop, AUTO_STOP, estimateAccuracy, predict, ACC_FIT } from './model.js';
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
  autoMemo: {},      // 終了判定に使う（src/model.js の shouldStop）
  // 出題した時点の予測がどれだけ当たったか。推定精度のもとになる。
  // 毎回ただで数えられるので、1問ごとに推定を更新できる。
  preqOk: 0,
  preqN: 0,
};

/* ---------------- 起動 ---------------- */
init();
showVersion();

/**
 * 画面の隅に版を出す。デプロイが反映されたかを目で確かめるためだけのもの。
 *
 * version.json は GitHub Actions がデプロイのたびに書き出す
 * （.github/workflows/pages.yml）。手元では存在しないので dev と出す。
 * 読めなくても診断には関係ないので、失敗しても黙って dev のままにする。
 */
async function showVersion() {
  const el = $('version');
  if (!el) return;
  el.textContent = 'dev';
  try {
    // デプロイ直後に古い版を見せないよう、キャッシュは使わない。
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const v = await res.json();
    if (v?.rev) el.textContent = v.builtAt ? `${v.rev} · ${v.builtAt}` : v.rev;
  } catch { /* 手元で動かしているときは version.json が無い */ }
}

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

/**
 * 問数の選択（横に送る形）。
 *
 * 出ているものがそのまま選択。押せば始まる。送るのは矢印・スワイプ・矢印キー。
 * 指で送っている間は transform を指に追従させ、離したところで近いほうへ収める。
 * スワイプと押し間違えないよう、動いた距離が小さいときだけ「押した」とみなす。
 */
function setupRounds(ROUNDS) {
  const box = $('rounds');
  const track = $('rounds-track');
  const view = $('rounds-view');
  let at = Math.max(0, ROUNDS.findIndex((r) => String(r.v) === String(state.rounds)));

  // 1枚ぶんの幅は CSS の --slide（view に対する％）で決める。100 未満なら
  // 余った左右に隣が覗くので、そのぶん真ん中へ寄せ直す必要がある。
  const slideW = () => Number(getComputedStyle(box).getPropertyValue('--slide')) || 100;
  const restOf = (i) => { const w = slideW(); return -i * w + (100 - w) / 2; };

  const apply = (animate = true) => {
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translateX(${restOf(at)}%)`;
    $('rounds-prev').disabled = at === 0;
    $('rounds-next').disabled = at === ROUNDS.length - 1;
    [...$('rounds-dots').children].forEach((d, i) => d.classList.toggle('is-on', i === at));
    // 画面の外にあるカードは、タブでも読み上げでも触れないようにする。
    [...track.children].forEach((slide, i) => {
      const c = slide.firstElementChild;
      c.tabIndex = i === at ? 0 : -1;
      slide.setAttribute('aria-hidden', i === at ? 'false' : 'true');
      slide.classList.toggle('is-on', i === at);
    });
    // 'auto' は数に直さない。回数を決めないモードの目印として文字のまま持つ。
    const v = ROUNDS[at].v;
    state.rounds = v === 'auto' ? 'auto' : Number(v);
  };
  const go = (d) => { at = Math.min(ROUNDS.length - 1, Math.max(0, at + d)); apply(); };
  apply(false);

  $('rounds-prev').onclick = () => go(-1);
  $('rounds-next').onclick = () => go(1);

  // 指で送る。pointer ならマウスでもタッチでも同じ扱いになる。
  let startX = 0, dx = 0, dragging = false, downAt = null;
  const width = () => view.getBoundingClientRect().width || 1;
  view.addEventListener('pointerdown', (e) => {
    // どの枚数を押したかは、ここで覚えておく。setPointerCapture のあとは
    // click の相手が view に付け替えられて、押した先が分からなくなる。
    const slide = e.target.closest?.('.rounds-slide');
    downAt = slide ? [...track.children].indexOf(slide) : null;
    dragging = true; startX = e.clientX; dx = 0;
    box.classList.add('is-dragging');
    track.style.transition = 'none';
    view.setPointerCapture?.(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    // 端では引っぱっても戻る量を減らして、これ以上無いことを手で伝える。
    const over = (at === 0 && dx > 0) || (at === ROUNDS.length - 1 && dx < 0);
    track.style.transform = `translateX(${restOf(at) + (dx / width()) * 100 * (over ? 0.3 : 1)}%)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('is-dragging');
    track.style.transition = '';
    // 幅の2割か60pxのどちらか小さいほうを越えたら送る。
    if (Math.abs(dx) > Math.min(60, width() * 0.2)) go(dx < 0 ? 1 : -1);
    else apply();
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);

  // キーボードでも送れるようにする。カードはボタンなので Enter で始まる。
  document.addEventListener('keydown', (e) => {
    if (!$('screen-start') || $('screen-start').hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });

  // 押したら始まる。ただし覗いている隣を押したときは、そちらへ送るだけ。
  // 覗きは「選べるものが他にもある」という合図なので、押して別の枚数で
  // 始まってしまうと押し間違いになる。
  // 受けるのは view。setPointerCapture を使うと click の相手が view に
  // 付け替えられるので、カード側に付けても届かない。
  // スワイプの終わりにも click が飛ぶため、動いていたら始めない。
  view.onclick = () => {
    const pressed = downAt;
    downAt = null;
    if (Math.abs(dx) > 6) return;
    // キーボードの Enter には pointerdown が無いので、そのときは真ん中扱い。
    if (pressed != null && pressed !== at) go(pressed - at);
    else startSession();
  };
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

  // 問数の選択。数字だけを1行に並べ、選んだものの説明は下に1行で出す。
  // 1つずつに説明と精度を書くと1つあたりが狭くなり、5つ並べると
  // 文字が折り返す。2段にすると今度は縦に伸びて最初の画面に収まらない。
  //
  // 精度は同梱プールでの実測値。npm run acc-check で確かめられる。
  // 顔・較正・ペアの選び方・測る項目のどれかを変えると動くので、
  // 公開する前に必ず確かめること（CLAUDE.md を参照）。
  const ROUNDS = [
    { v: 20, label: 'さくっと', acc: 79 },
    { v: 30, label: 'おすすめ', acc: 82 },
    { v: 45, label: 'しっかり', acc: 85 },
    { v: 90, label: 'とことん', acc: 89 },
    // 回数を決めず、推定精度が目標に届くまで続ける（src/model.js の AUTO_STOP）。
    // 問数は人によって変わるので数は出さない。
    { v: 'auto', label: 'おまかせ', note: 'はっきりするまで' },
  ];
  // 1枚ずつ大きく見せ、左右のボタンかスワイプで送る。
  // 出ているものがそのまま選択なので、「はじめる」ボタンは要らない。押せば始まる。
  // 1枚ぶんの枠（rounds-slide）の内側にカードを置く。カードが枠いっぱいだと、
  // 脈打ちで膨らんだぶんが隣にはみ出して、隣のカードの縁が覗いてしまう。
  $('rounds-track').innerHTML = ROUNDS.map((r) => `
    <div class="rounds-slide">
      <button class="rounds-card" data-value="${r.v}"
        aria-label="${r.v === 'auto' ? 'おまかせ' : r.v + '問'}ではじめる">
        <span class="rounds-num">${r.v === 'auto' ? '？' : r.v}</span>
        <span class="rounds-label">${r.label}</span>
        <span class="rounds-sub">${r.note ?? `精度 ${r.acc}%`}</span>
      </button>
    </div>`).join('');
  $('rounds-dots').innerHTML = ROUNDS.map(() => '<i></i>').join('');
  $('rounds-prev').innerHTML = icon('caretLeft');
  $('rounds-next').innerHTML = icon('caretRight');
  setupRounds(ROUNDS);


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
  state.preqOk = 0;
  state.preqN = 0;
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

/** 出題時の予測の的中率を履歴から数え直す。推定精度のもとになる。 */
function recountPreq() {
  const hits = state.history.filter((h) => h.hit !== null && h.hit !== undefined);
  state.preqN = hits.length;
  state.preqOk = hits.filter((h) => h.hit).length;
  state.autoMemo.preq = state.preqN > 0 ? state.preqOk / state.preqN : undefined;
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

  // 出題した時点の予測が当たっていたかを記録する（モデルがあるときだけ）。
  // 戻るで数え直せるよう、履歴に持たせる。
  const hit = state.model ? (predict(state.model, a.v, b.v) > 0.5) === (side === 0) : null;

  state.history.push({ a, b, winner: win.id, skipped: false, hit });
  recountPreq();
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
  // 終了判定の数えも戻す。戻した回の分を数えたままだと、
  // 戻ったのに終わってしまう。
  state.autoMemo = {};
  recountPreq();
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
    // 出題時の予測の的中率。推定精度（accRange）のもとになる。
    preq: state.preqN > 0 ? state.preqOk / state.preqN : null,
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

  $('t-accuracy').innerHTML = `${icon('chart')}診断の精度`;
  const est = accRange(r);
  slides.push({
    cls: 'st-consist',
    html: `<p class="st-kicker">この診断が当たる確からしさは</p>
      <h2 class="st-big"><span class="st-num" data-num="${est.mid}">0%</span></h2>
      <p class="st-lead">${pct >= 78 ? '<b>迷いなく</b>選べていました'
        : pct >= 68 ? '好みは<b>一貫</b>しています'
        : pct >= 60 ? '<b>少し迷いながら</b>選んでいました'
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
/**
 * 「理想の顔を生成」。測った好みから、その場で1枚作る。
 * プールから選ぶのではないので、その人の理想そのものに近づける。
 *
 * 鍵はこのアプリのどこにも置かない。静的サイトなので同梱すると
 * 誰でも読めてしまう。入力欄に鍵そのものを入れてもらい、
 * その端末の中だけで使う（src/ideal.js のコメントを参照）。
 */
function setupIdeal(r) {
  const modal = $('ideal-modal');
  const keyBox = $('ideal-key');
  const err = $('ideal-error');
  const status = $('ideal-status');
  const stage = $('ideal-stage');

  const viewer = $('ideal-viewer');
  const saveLink = $('ideal-save');

  $('t-ideal').innerHTML = `${icon('sparkle')}あなただけの理想の顔`;
  $('ideal-price').textContent = `1枚 ${PRICE_YEN}円`;
  $('ideal-price-note').textContent = `1枚 ${PRICE_YEN}円`;
  $('btn-ideal').innerHTML = `${icon('sparkle')}<span>理想の顔をつくる</span>`;
  // 特徴を並べると「条件を満たす顔」に見える。
  // ここで売りたいのは「自分のためだけに作られた1枚」という感じなので、
  // 何を見ていたかは他のカードに任せて、ここでは触れない。
  $('ideal-note').textContent = 'この世界にまだ存在しない、あなたの好みだけでできた顔を、いま作ります。';

  const close = () => { modal.hidden = true; err.hidden = true; };
  /** 入力し直してもらう。文言を出したまま開き、中身は選んでおく。 */
  const reopen = (message) => {
    err.textContent = message;
    err.hidden = false;
    modal.hidden = false;
    keyBox.focus();
    keyBox.select();
  };
  $('btn-ideal').onclick = () => {
    err.hidden = true;
    modal.hidden = false;
    // 同じ端末で続けて作るときに打ち直さなくてよいようにする。
    try { keyBox.value = sessionStorage.getItem(IDEAL_KEY_STORE) ?? ''; } catch { /* 使えない環境は空のまま */ }
    keyBox.focus();
  };
  $('ideal-cancel').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  // ビューア。作った直後に開くほか、カードの1枚を押しても開く。
  saveLink.innerHTML = `${icon('download')}<span>保存</span>`;
  $('ideal-close').innerHTML = `${icon('close')}<span>閉じる</span>`;
  const closeViewer = () => { viewer.hidden = true; };
  $('ideal-close').onclick = closeViewer;
  viewer.onclick = (e) => { if (e.target === viewer) closeViewer(); };
  $('ideal-img').onclick = () => { if ($('ideal-img').src) showIdeal($('ideal-img').src); };
  keyBox.onkeydown = (e) => { if (e.key === 'Enter') $('ideal-go').click(); };

  $('ideal-go').onclick = async () => {
    const key = keyBox.value.trim();
    if (!key) { reopen('パスワードを入れてください。'); return; }
    close();
    try { sessionStorage.setItem(IDEAL_KEY_STORE, key); } catch { /* 保存できなくても動く */ }

    $('btn-ideal').disabled = true;
    status.hidden = false;
    status.classList.remove('is-error');
    stage.hidden = true;
    status.textContent = '作っています…';
    try {
      const src = await generateIdeal(key, buildIdealPrompt(r), {
        // 失敗しても黙って作り直す。何回目かだけ見せる。
        onTry: (n) => { status.textContent = n === 1 ? '作っています…' : `作り直しています…（${n}回目）`; },
      });
      $('ideal-img').src = src;
      stage.hidden = false;
      status.hidden = true;
      $('btn-ideal').innerHTML = `${icon('replay')}<span>もう1枚作る</span>`;
      // 300円かけて作った1枚なので、まず画面いっぱいで見せる。
      showIdeal(src);
    } catch (e) {
      // パスワード違いは打ち間違いなので、閉じた窓をそのまま開き直して知らせる。
      // カードの隅に小さく出すだけだと、間違えたことに気づかないまま
      // 「作れなかった」とだけ読まれてしまう。
      if (e instanceof BadKey) {
        // 間違った鍵を覚えたままにしない。次に開いたとき同じ鍵が入っていると、
        // 押すだけでまた同じ失敗を繰り返す。
        try { sessionStorage.removeItem(IDEAL_KEY_STORE); } catch { /* 消せなくても困らない */ }
        status.hidden = true;
        reopen(e.message);
      } else {
        status.textContent = e.message;
        status.classList.add('is-error');
      }
    } finally {
      $('btn-ideal').disabled = false;
    }
  };
}

/**
 * 生成した1枚を画面いっぱいで見せる。保存もここから。
 *
 * 保存は data: URL のままだと端末によっては落とせないので、
 * Blob に直してから渡す。それでも落とせない端末（iOS の一部）が
 * あるので、画面に「長押しでも保存できる」と添えてある。
 */
function showIdeal(src) {
  const viewer = $('ideal-viewer');
  $('ideal-full').src = src;
  const link = $('ideal-save');
  // 前の1枚で作った URL は、ここで捨てないと残り続ける。
  if (link.dataset.blobUrl) { URL.revokeObjectURL(link.dataset.blobUrl); delete link.dataset.blobUrl; }
  link.href = src;
  fetch(src).then((r) => r.blob()).then((b) => {
    const url = URL.createObjectURL(b);
    link.href = url;
    link.dataset.blobUrl = url;
    // 拡張子は中身に合わせる。png を .jpg で保存すると開けない端末がある。
    link.download = `facematch-ideal.${(b.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
  }).catch(() => { /* data: URL のままでも落とせる端末は多い */ });
  viewer.hidden = false;
}

const IDEAL_KEY_STORE = 'facematch.ideal.key';

/**
 * この診断がどれくらい当たるかの見積もり（%の幅）。
 * 推定には6ポイントほどの誤差があるので、点ではなく幅で出す。
 * 見積もり方は src/model.js の estimateAccuracy を参照。
 */
function accRange(r) {
  const preq = r.preq ?? (r.loo ?? null);
  const mid = estimateAccuracy(r.rounds, preq ?? undefined);
  const half = ACC_FIT.mae;
  return {
    mid: Math.round(mid * 100),
    lo: Math.round(Math.max(0.5, mid - half) * 100),
    hi: Math.round(Math.min(0.97, mid + half) * 100),
  };
}

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

  // 出すのは「この診断がどれくらい当たるか」。
  // 以前はブレの少なさ（loo）をそのまま％で出していたが、あれは
  // 出題されたペアだけで測った正答率で、出題は常に「モデルが
  // いちばん自信のないペア」なので、どれだけ答えても70%前後から動かない。
  // 65%と出ても診断が65%しか当たらないという意味ではなかった。
  const est = accRange(r);
  // 丸いゲージの中は3〜4文字しか入らない。幅（60–74%）を入れると
  // 折り返してはみ出すので、中は真ん中の値だけにして幅は下の行に出す。
  $('consistency-num').textContent = `${est.mid}%`;
  $('consistency-note').textContent = `およそ ${est.lo}〜${est.hi}% の確からしさ`;
  // ブレ具合は数字にせず、言葉だけで伝える。
  const loo = Math.round((r.loo ?? r.trainAccuracy) * 100);
  $('consistency-label').textContent = loo >= 78 ? '迷いなく選べています'
    : loo >= 68 ? '好みは一貫しています'
    : loo >= 60 ? '少し迷いながら選んでいます'
    : '気分で選んでいるかも';

  $('chosen-strip').innerHTML = r.chosen.filter((id) => srcOf(id))
    .map((id) => `<img src="${srcOf(id)}" alt="" loading="lazy">`).join('');

  setupIdeal(r);

  $('btn-again').innerHTML = `${icon('replay')}<span>もう一度</span>`;
  $('btn-again').onclick = () => { buildStartScreen(); show('screen-start'); };
  $('btn-copy').innerHTML = `${icon('copy')}<span>結果をコピー</span>`;
  $('btn-copy').onclick = () => copyResult(r);

  // 描画が終わってからバー・ゲージ・数値を動かす
  requestAnimationFrame(() => {
    document.querySelectorAll('.feat-fill, .fm-fill').forEach((el) => { el.style.width = el.dataset.w; });
    document.querySelectorAll('.marker, .style-marker').forEach((el) => { el.style.left = el.dataset.left; });
    $('gauge-fill').style.strokeDashoffset = String(264 - 264 * (est.mid / 100));
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
    `${r.rounds}問で診断 · 確からしさ ${accRange(r).lo}〜${accRange(r).hi}%`,
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

// Esc は、開いているものを上から順に閉じる。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('ideal-viewer').hidden) { $('ideal-viewer').hidden = true; return; }
  if (!$('ideal-modal').hidden) $('ideal-modal').hidden = true;
});

document.addEventListener('keydown', (e) => {
  if ($('screen-play').hidden) return;
  if (e.key === 'ArrowLeft' || e.key === '1') { e.preventDefault(); choose(0); }
  else if (e.key === 'ArrowRight' || e.key === '2') { e.preventDefault(); choose(1); }
  else if (e.key === ' ') { e.preventDefault(); skip(); }
  else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
});
