// 画面遷移と診断の進行。推定そのものは model.js、特徴の定義は features.js にある。

import { FEATURES, KEYS, normalizePool } from './features.js';
import { fit, choosePair, updateStats, newStats, score, looAccuracy } from './model.js';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = true; });
  $(id).hidden = false;
  window.scrollTo(0, 0);
};

const STORE_KEY = 'find-type/last-result';
const MIN_FACES = 12;  // 1回の診断に必要な最小の顔数
// ?data=... で別の顔プールに差し替えられる（動作確認用のダミープールなど）
const DATA = (new URLSearchParams(location.search).get('data') ?? 'data').replace(/\/+$/, '');
const faceSrc = (file) => `${DATA}/faces/${file}`;

const state = {
  pool: [],          // 全画像（正規化済み）
  faces: [],         // 今回使う性別に絞ったもの
  gender: 'female',
  rounds: 30,
  round: 0,
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
    const res = await fetch(`${DATA}/faces.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${DATA}/faces.json を読み込めません (HTTP ${res.status})`);
    const json = await res.json();
    const faces = json.faces ?? [];
    if (faces.length < MIN_FACES) throw new Error(`顔画像が ${faces.length} 枚しかありません。${MIN_FACES}枚以上必要です。`);
    state.pool = normalizePool(faces);
  } catch (e) {
    $('setup-error').textContent = e.message;
    show('screen-setup-needed');
    return;
  }
  buildStartScreen();
  show('screen-start');
}

/* ---------------- スタート画面 ---------------- */
function buildStartScreen() {
  const counts = state.pool.reduce((m, f) => (m[f.gender] = (m[f.gender] ?? 0) + 1, m), {});
  const nFemale = counts.female ?? 0, nMale = counts.male ?? 0;
  const options = [
    { value: 'female', label: '女性の顔', n: nFemale },
    { value: 'male', label: '男性の顔', n: nMale },
  ].filter((o) => o.n >= MIN_FACES);
  // 「両方」は両方の性別が単独で足りているときだけ意味がある。
  // 片方しかいないプールで出すと同じ選択肢が2つ並んでしまう。
  if (nFemale >= MIN_FACES && nMale >= MIN_FACES) {
    options.push({ value: 'all', label: '両方', n: state.pool.length });
  } else if (!options.length && state.pool.length >= MIN_FACES) {
    options.push({ value: 'all', label: 'すべての顔', n: state.pool.length });
  }

  const box = $('gender-choices');
  box.innerHTML = '';
  options.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'choice' + (i === 0 ? ' is-on' : '');
    b.dataset.value = o.value;
    b.innerHTML = `${o.label}<span class="sub">${o.n}枚</span>`;
    box.appendChild(b);
  });
  state.gender = options[0]?.value ?? 'all';
  box.previousElementSibling.textContent = options.length > 1
    ? '診断する顔'
    : '診断する顔（今のプールにはこれだけあります）';
  bindChoices(box, (v) => { state.gender = v; updateRoundsHint(); });
  bindChoices($('rounds-choices'), (v) => { state.rounds = Number(v); updateRoundsHint(); });
  updateRoundsHint();

  $('pool-info').textContent = `顔画像 ${state.pool.length} 枚 / 診断項目 ${FEATURES.length} 個`;
  $('btn-start').onclick = startSession;
  $('btn-last-result').hidden = !localStorage.getItem(STORE_KEY);
  $('btn-last-result').onclick = () => {
    try { renderResult(JSON.parse(localStorage.getItem(STORE_KEY))); show('screen-result'); }
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

function updateRoundsHint() {
  // test/simulate.mjs で測った、仮想ユーザーの好みを当てられた割合
  const acc = { 20: 78, 30: 83, 45: 86 }[state.rounds] ?? 83;
  $('rounds-hint').textContent = `シミュレーションでの推定精度の目安: 約${acc}%`;
}

/* ---------------- 診断の進行 ---------------- */
function startSession() {
  state.faces = state.gender === 'all' ? state.pool : state.pool.filter((f) => f.gender === state.gender);
  state.round = 0;
  state.history = [];
  state.stats = newStats();
  state.model = null;
  show('screen-play');
  nextRound();
}

function nextRound() {
  if (state.round >= state.rounds) return finishSession();
  // 序盤はモデルが当てにならないので、推定を使い始めるのは数回たってから
  const model = state.history.length >= 6 ? state.model : null;
  state.pair = choosePair(state.faces, model, state.stats);
  renderPair();
}

function renderPair() {
  const [a, b] = state.pair;
  $('img-0').src = faceSrc(a.file);
  $('img-1').src = faceSrc(b.file);
  document.querySelectorAll('.face-card').forEach((c) => c.classList.remove('is-picked'));
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
    [a, b].forEach((f) => { new Image().src = faceSrc(f.file); });
  } catch { /* プールが小さいときは何もしない */ }
}

function choose(side) {
  if (state.busy || !state.pair) return;
  const [a, b] = state.pair;
  const win = side === 0 ? a : b, lose = side === 0 ? b : a;
  document.querySelectorAll('.face-card')[side].classList.add('is-picked');
  state.busy = true;

  setTimeout(() => {
    state.history.push({ a, b, winner: win.id, skipped: false });
    updateStats(state.stats, a, b);
    state.round++;
    // 選択が増えるたび再推定し、次のペア選びに反映する
    if (state.history.length >= 6) state.model = fit(comparisons());
    state.busy = false;
    nextRound();
  }, 140);
}

function skip() {
  if (state.busy || !state.pair) return;
  const [a, b] = state.pair;
  // スキップは好みの情報にならないので記録しない。ただし同じ組は再提示しない。
  state.stats.usedPairs.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  state.history.push({ a, b, winner: null, skipped: true });
  state.round++;
  nextRound();
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  state.round = Math.max(0, state.round - 1);
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
    top: ranked.slice(0, 3).map((f) => f.file),
    chosen: state.history.filter((h) => !h.skipped).map((h) => (h.winner === h.a.id ? h.a : h.b).file),
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
  $('result-title').textContent = typeName(r);
  const top = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a])[0];
  $('result-sub').textContent =
    `${r.rounds}回の選択から推定${r.skipped ? `（スキップ ${r.skipped}回）` : ''}。`
    + `いちばん効いていたのは「${FEATURES[top].name}」でした。`;

  $('pool-count').textContent = r.poolSize;
  $('top-faces').innerHTML = r.top.map((f, i) => `
    <figure><img src="${faceSrc(f)}" alt="好みに近い顔 ${i + 1}位" loading="lazy">
    <figcaption>${i + 1}位</figcaption></figure>`).join('');

  renderFeatures(r);

  const pct = Math.round((r.loo ?? r.trainAccuracy) * 100);
  $('consistency-num').textContent = `${pct}%`;
  const label = pct >= 85 ? '好みがはっきりしています'
    : pct >= 72 ? '好みは一貫しています'
    : pct >= 60 ? 'ややブレがあります'
    : '気分で選んでいるかもしれません';
  $('consistency-label').textContent = label;
  $('consistency-note').textContent =
    '1問を隠して残りから学習し、その1問を当てられた割合です（交差検証）。'
    + '高いほど、選択が一定の基準にもとづいていることを意味します。';

  $('chosen-strip').innerHTML = r.chosen.map((f) => `<img src="${faceSrc(f)}" alt="" loading="lazy">`).join('');

  $('btn-again').onclick = () => { buildStartScreen(); show('screen-start'); };
  $('btn-copy').onclick = () => copyResult(r);
}

function renderFeatures(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]);
  const max = Math.max(...r.importance);
  // 重視度が低くても上位6件は必ず見せる（1項目だけだと結果が読み取りにくいため）
  const nStrong = Math.max(6, order.filter((i) => r.importance[i] >= 0.05).length);
  const strong = order.slice(0, nStrong);
  const weak = order.slice(nStrong);

  const row = (i) => {
    const f = FEATURES[i], m = r.m[i], imp = r.importance[i];
    const isWeak = imp < 0.05;
    return `<div class="feat${isWeak ? ' is-weak' : ''}">
      <div class="feat-head">
        <span class="feat-name">${f.name}</span>
        <span class="feat-pct">${Math.round(imp * 100)}%<span class="feat-support"> ・差のあった比較 ${r.support?.[i] ?? 0}回</span></span>
      </div>
      <div class="feat-bar"><div class="feat-fill" style="width:${(imp / max) * 100}%"></div></div>
      <div class="axis">
        <span class="pole low">${f.low}</span>
        <div class="track"><span class="marker" style="left:${m * 100}%">▼</span></div>
        <span class="pole high">${f.high}</span>
      </div>
    </div>`;
  };

  $('feature-list').innerHTML = strong.map(row).join('');
  const btn = $('btn-show-rest');
  btn.hidden = weak.length === 0;
  btn.onclick = () => {
    $('feature-list').innerHTML = order.map(row).join('');
    btn.hidden = true;
  };
}

async function copyResult(r) {
  const order = KEYS.map((_, i) => i).sort((a, b) => r.importance[b] - r.importance[a]).slice(0, 3);
  const text = [
    '【顔の好み診断】',
    `タイプ: ${typeName(r)}`,
    `重視した特徴: ${order.map((i) => `${FEATURES[i].name}(${Math.round(r.importance[i] * 100)}%)`).join(' / ')}`,
    `好みの一貫性: ${Math.round((r.loo ?? r.trainAccuracy) * 100)}%（${r.rounds}回の選択）`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('btn-copy').textContent = 'コピーしました';
  } catch {
    $('btn-copy').textContent = 'コピーできませんでした';
  }
  setTimeout(() => { $('btn-copy').textContent = '結果をコピー'; }, 1800);
}

/* ---------------- 入力 ---------------- */
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
