// 画面遷移と診断の進行。推定そのものは model.js、特徴の定義は features.js にある。

import { FEATURES, KEYS, normalizePool } from './features.js';
import { fit, choosePair, updateStats, newStats, score, looAccuracy } from './model.js';
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
  history: [],       // { a, b, winner, skipped }
  stats: newStats(),
  model: null,
  busy: false,
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
  state.pool = normalizePool(await loadBundled());
  state.byId = new Map(state.pool.map((f) => [f.id, f]));
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
    { v: 20, label: 'さくっと', acc: 78 },
    { v: 30, label: 'おすすめ', acc: 83 },
    { v: 45, label: 'じっくり', acc: 86 },
  ].map((r) => `<button class="choice${r.v === state.rounds ? ' is-on' : ''}" data-value="${r.v}">
      <span class="big">${r.v}</span><span class="sub">${r.label}</span>
      <span class="acc">精度 ${r.acc}%</span></button>`).join('');

  bindChoices($('rounds-choices'), (v) => { state.rounds = Number(v); });

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
  show('screen-play');
  nextRound();
}

function nextRound() {
  if (state.round >= state.rounds) return finishSession();
  // スキップが続いても終わらなくならないように上限を設ける
  if (state.shown >= state.rounds * 3) return finishSession();
  state.shown++;
  // 序盤はモデルが当てにならないので、推定を使い始めるのは数回たってから
  const model = state.history.length >= 6 ? state.model : null;
  state.pair = choosePair(state.faces, model, state.stats);
  renderPair();
}

function renderPair() {
  const [a, b] = state.pair;
  $('img-0').src = a.src;
  $('img-1').src = b.src;
  document.querySelectorAll('.face-card').forEach((c) => {
    c.classList.remove('is-picked', 'is-dropped');
    // 入場アニメーションをやり直させる
    c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
  });
  $('round-label').textContent = `${state.round + 1} / ${state.rounds}`;
  $('progress-fill').style.width = `${(state.round / state.rounds) * 100}%`;
  $('btn-undo').disabled = state.history.length === 0;
  preloadNext();
}

// 次に出そうな顔を先に読み込んでおき、切り替わりのちらつきを防ぐ
function preloadNext() {
  const model = state.history.length >= 6 ? state.model : null;
  try {
    const [a, b] = choosePair(state.faces, model, state.stats);
    [a, b].forEach((f) => { new Image().src = f.src; });
  } catch { /* プールが小さいときは何もしない */ }
}

function choose(side) {
  if (state.busy || !state.pair) return;
  const [a, b] = state.pair;
  const win = side === 0 ? a : b, lose = side === 0 ? b : a;
  const cards = document.querySelectorAll('.face-card');
  cards[side].classList.add('is-picked');
  cards[1 - side].classList.add('is-dropped');
  state.busy = true;

  setTimeout(() => {
    state.history.push({ a, b, winner: win.id, skipped: false });
    updateStats(state.stats, a, b);
    state.round++;
    // 選択が増えるたび再推定し、次のペア選びに反映する
    if (state.history.length >= 6) state.model = fit(comparisons());
    state.busy = false;
    nextRound();
  }, 420);
}

function skip() {
  if (state.busy || !state.pair) return;
  const [a, b] = state.pair;
  // スキップは好みの情報にならないので記録せず、回数にも数えない。
  // 数えてしまうと、画面に出している精度（答えた回数に対する値）より
  // 実際の精度が低くなってしまう。同じ組は再提示しない。
  state.stats.usedPairs.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  state.history.push({ a, b, winner: null, skipped: true });
  nextRound();
}

function undo() {
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
  state.pair = [last.a, last.b];
  renderPair();
}

const comparisons = () => state.history.filter((h) => !h.skipped).map((h) => {
  const win = h.winner === h.a.id ? h.a : h.b;
  const lose = h.winner === h.a.id ? h.b : h.a;
  return { win: win.v, lose: lose.v };
});

/* ---------------- 結果 ---------------- */
function finishSession() {
  const cs = comparisons();
  if (cs.length < 6) {
    alert('スキップが多く、判定できるだけの選択が集まりませんでした。もう一度お試しください。');
    show('screen-start');
    return;
  }
  const model = fit(cs);
  const loo = looAccuracy(cs);

  const ranked = [...state.faces].sort((x, y) => score(model, y.v) - score(model, x.v));
  const payload = {
    at: new Date().toISOString(),
    gender: state.gender,
    rounds: cs.length,
    skipped: state.history.length - cs.length,
    m: model.m, importance: model.importance, support: model.support,
    loo, trainAccuracy: model.trainAccuracy,
    poolSize: state.faces.length,
    top: ranked.slice(0, 3).map((f) => f.id),
    chosen: state.history.filter((h) => !h.skipped).map((h) => h.winner),
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch { /* 容量超過は無視 */ }
  renderResult(payload);
  show('screen-result');
}

/** 重視度の高い特徴を並べてタイプ名にする */
function typeName(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  const tags = [];
  for (const i of order) {
    if (tags.length >= 3) break;
    if (r.importance[i] < 0.085 || (r.support?.[i] ?? 0) < 3) continue;
    const f = FEATURES[i], m = r.m[i];
    tags.push(m > 0.62 ? f.highTag : m < 0.38 ? f.lowTag : `中間の${f.name}`);
  }
  return tags.length ? tags.join(' × ') : 'こだわり少なめのオールラウンド';
}

function renderResult(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  $('result-title').textContent = typeName(r);

  // 上位項目をタグで見せる（説明文の代わり）。
  // 重視度がほぼ0の項目を並べても意味がないので、目立つものだけ出す。
  const shown = order.filter((i) => r.importance[i] >= 0.05).slice(0, 3);
  $('result-tags').innerHTML = (shown.length ? shown : order.slice(0, 1)).map((i, n) =>
    `<span class="tag" style="--i:${n}">${featureIcon(KEYS[i])}${FEATURES[i].name}
       <b>${Math.round(r.importance[i] * 100)}%</b></span>`).join('');

  $('t-top').innerHTML = `${icon('crown')}好みに近い顔`;
  $('t-feat').innerHTML = `${icon('chart')}効いていた特徴`;
  $('t-chosen').innerHTML = `${icon('heart', { cls: 'is-heart' })}選んだ顔 <span class="card-note">${r.chosen.length}枚</span>`;

  const srcOf = (id) => state.byId.get(id)?.src ?? '';
  $('top-faces').innerHTML = r.top.filter((id) => srcOf(id)).map((id, i) => `
    <figure><img src="${srcOf(id)}" alt="好みに近い顔 ${i + 1}位" loading="lazy">
    <span class="rank">${i + 1}</span></figure>`).join('');

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
    document.querySelectorAll('.feat-fill').forEach((el) => { el.style.width = el.dataset.w; });
    document.querySelectorAll('.marker').forEach((el) => { el.style.left = el.dataset.left; });
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

function renderFeatures(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  const max = Math.max(...r.importance);
  // 重視度が低くても上位6件は必ず見せる（1項目だけだと結果が読み取りにくいため）
  const nStrong = Math.max(6, order.filter((i) => r.importance[i] >= 0.05).length);
  const strong = order.slice(0, nStrong);
  const weak = order.slice(nStrong);

  const row = (i, n) => {
    const f = FEATURES[i], m = r.m[i], imp = r.importance[i];
    return `<div class="feat${imp < 0.05 ? ' is-weak' : ''}" style="--i:${n}">
      <div class="feat-head">
        ${featureIcon(f.key)}
        <span class="feat-name">${f.name}</span>
        <span class="feat-pct">${Math.round(imp * 100)}%</span>
      </div>
      <div class="feat-bar"><div class="feat-fill" data-w="${(imp / max) * 100}%"></div></div>
      <div class="axis">
        <span class="pole low">${f.lowTag}</span>
        <div class="track"><span class="marker" data-left="${m * 100}%"></span></div>
        <span class="pole high">${f.highTag}</span>
      </div>
    </div>`;
  };

  $('feature-list').innerHTML = strong.map(row).join('');
  const btn = $('btn-show-rest');
  btn.hidden = weak.length === 0;
  btn.onclick = () => {
    $('feature-list').innerHTML = order.map(row).join('');
    btn.hidden = true;
    requestAnimationFrame(() => {
      document.querySelectorAll('.feat-fill').forEach((el) => { el.style.width = el.dataset.w; });
      document.querySelectorAll('.marker').forEach((el) => { el.style.left = el.dataset.left; });
    });
  };
}

async function copyResult(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]).slice(0, 3);
  const text = [
    '【顔の好み診断】',
    `私のタイプ → ${typeName(r)}`,
    order.map((i) => `${FEATURES[i].name} ${Math.round(r.importance[i] * 100)}%`).join(' / '),
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
$('vs').innerHTML = icon('heartFill', { cls: 'is-heart' });
document.querySelectorAll('.burst').forEach((b) => { b.innerHTML = icon('heartFill', { cls: 'is-heart' }); });
$('btn-undo').innerHTML = icon('undo');
$('btn-skip').innerHTML = `${icon('skip')}<span>どちらもピンとこない</span>`;
document.querySelectorAll('.face-card').forEach((card) => {
  card.addEventListener('click', () => choose(Number(card.dataset.side)));
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
