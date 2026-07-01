import { SKIN_META, COND_META, ING, METRICS, computeState, statusLine, lerpHex } from './state.js';
import { SkinScene } from './scene.js';

// ---------- element refs ----------
const el = {
  stageMount: document.getElementById('stage-mount'),
  statusText: document.getElementById('status-text'),
  loading: document.getElementById('loading'),
  playBtn: document.getElementById('play-btn'),
  playIcon: document.getElementById('play-icon'),
  monthLabel: document.getElementById('month-label'),
  scrub: document.getElementById('scrub'),
  scrubHint: document.getElementById('scrub-hint'),
  skinGrid: document.getElementById('skin-grid'),
  skinBlurb: document.getElementById('skin-blurb'),
  conditionList: document.getElementById('condition-list'),
  ingredientList: document.getElementById('ingredient-list'),
  ingBlurb: document.getElementById('ing-blurb'),
  pourBtn: document.getElementById('pour-btn'),
  resetBtn: document.getElementById('reset-btn'),
  metricsList: document.getElementById('metrics-list'),
};

// ---------- state store ----------
let scene = null;
let state = {
  ready: false,
  skinType: 'oily',
  conditions: { acne: true, scars: false, pigment: false, redness: false, lines: false },
  ingredient: 'salicylic',
  months: 0,
  poured: false,
  pouring: false,
  playing: false,
};

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

function setScenario(patch) {
  if (scene) scene.clearPour();
  scene && (scene.playing = false);
  setState({ ...patch, poured: false, months: 0, pouring: false, playing: false });
}

function toggleCond(k) {
  const conditions = { ...state.conditions, [k]: !state.conditions[k] };
  if (scene) scene.clearPour();
  scene && (scene.playing = false);
  setState({ conditions, poured: false, months: 0, pouring: false, playing: false });
}

function onScrub(e) {
  setState({ months: parseFloat(e.target.value), playing: false });
}

function togglePlay() {
  if (!state.poured) return;
  if (state.playing) {
    setState({ playing: false });
    if (scene) scene.playing = false;
  } else {
    const playT = state.months >= 6 ? 0 : state.months;
    if (scene) { scene.playT = playT; scene.playing = true; }
    setState({ playing: true, months: playT });
  }
}

function pour() {
  if (scene) scene.pour(state.ingredient);
}

function reset() {
  if (scene) { scene.clearPour(); scene.playing = false; }
  setState({ poured: false, months: 0, playing: false });
}

el.resetBtn.addEventListener('click', reset);
el.pourBtn.addEventListener('click', pour);
el.playBtn.addEventListener('click', togglePlay);
el.scrub.addEventListener('input', onScrub);
el.scrub.addEventListener('change', onScrub);

// ---------- static (non-reactive) lists ----------
function buildSkinGrid() {
  el.skinGrid.innerHTML = '';
  for (const key of Object.keys(SKIN_META)) {
    const btn = document.createElement('button');
    btn.className = 'seg-btn';
    btn.textContent = SKIN_META[key].label;
    btn.dataset.key = key;
    btn.addEventListener('click', () => setScenario({ skinType: key }));
    el.skinGrid.appendChild(btn);
  }
}

function buildConditionList() {
  el.conditionList.innerHTML = '';
  for (const key of Object.keys(COND_META)) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.textContent = COND_META[key];
    btn.dataset.key = key;
    btn.addEventListener('click', () => toggleCond(key));
    el.conditionList.appendChild(btn);
  }
}

function buildIngredientList() {
  el.ingredientList.innerHTML = '';
  for (const key of Object.keys(ING)) {
    const ing = ING[key];
    const btn = document.createElement('button');
    btn.className = 'ing-btn';
    btn.dataset.key = key;
    const dot = document.createElement('span');
    dot.className = 'ing-dot';
    dot.style.background = ing.color;
    const textCol = document.createElement('span');
    textCol.className = 'ing-text';
    const label = document.createElement('span');
    label.className = 'ing-label';
    label.textContent = ing.label;
    const desc = document.createElement('span');
    desc.className = 'ing-desc';
    desc.textContent = ing.short;
    textCol.appendChild(label);
    textCol.appendChild(desc);
    btn.appendChild(dot);
    btn.appendChild(textCol);
    btn.addEventListener('click', () => setScenario({ ingredient: key }));
    el.ingredientList.appendChild(btn);
  }
}

function buildMetricsList() {
  el.metricsList.innerHTML = '';
  for (const m of METRICS) {
    const row = document.createElement('div');
    row.dataset.key = m.key;
    const top = document.createElement('div');
    top.className = 'metric-row-top';
    const label = document.createElement('span');
    label.className = 'metric-label';
    label.textContent = m.label;
    const right = document.createElement('span');
    right.className = 'metric-right';
    const delta = document.createElement('span');
    delta.className = 'metric-delta hidden';
    const val = document.createElement('span');
    val.className = 'metric-val';
    right.appendChild(delta);
    right.appendChild(val);
    top.appendChild(label);
    top.appendChild(right);
    const track = document.createElement('div');
    track.className = 'metric-track';
    const fill = document.createElement('div');
    fill.className = 'metric-fill';
    track.appendChild(fill);
    row.appendChild(top);
    row.appendChild(track);
    el.metricsList.appendChild(row);
  }
}

buildSkinGrid();
buildConditionList();
buildIngredientList();
buildMetricsList();

// ---------- reactive render ----------
function render() {
  const S = state;
  const eff = S.poured ? S.months : 0;
  const scenario = { skinType: S.skinType, conditions: S.conditions, ingredient: S.ingredient };
  const cur = computeState(scenario, eff);
  const base = computeState(scenario, 0);

  el.loading.classList.toggle('hidden', S.ready);
  el.statusText.textContent = statusLine(cur, base, eff, S.poured);

  for (const btn of el.skinGrid.children) {
    btn.classList.toggle('active', btn.dataset.key === S.skinType);
  }
  el.skinBlurb.textContent = SKIN_META[S.skinType].blurb;

  for (const btn of el.conditionList.children) {
    btn.classList.toggle('active', !!S.conditions[btn.dataset.key]);
  }

  for (const btn of el.ingredientList.children) {
    btn.classList.toggle('active', btn.dataset.key === S.ingredient);
  }
  el.ingBlurb.textContent = ING[S.ingredient].blurb;

  const ing = ING[S.ingredient];
  el.pourBtn.textContent = S.pouring ? 'Pouring…' : S.poured ? 'Re-pour ' + ing.label.split(' ')[0] : 'Pour ' + ing.label.split(' ')[0];
  el.pourBtn.classList.toggle('pouring', S.pouring);
  el.pourBtn.disabled = S.pouring;

  el.playBtn.classList.toggle('active', S.poured);
  el.playIcon.classList.toggle('playing', S.playing);
  el.monthLabel.textContent = eff <= 0 ? 'Day 0' : 'Month ' + S.months.toFixed(1);
  el.scrub.disabled = !S.poured;
  if (document.activeElement !== el.scrub) el.scrub.value = String(S.months);
  el.scrubHint.classList.toggle('hidden', S.poured);

  for (const m of METRICS) {
    const row = el.metricsList.querySelector(`[data-key="${m.key}"]`);
    const now = cur[m.key], b = base[m.key];
    const pct = m.count ? Math.min(now, m.rng) / m.rng : now / 100;
    const health = 1 - Math.min(1, Math.abs(now - m.ideal) / m.rng);
    const col = lerpHex('#c37a4c', '#7f9a63', health);
    const dNow = Math.abs(now - m.ideal), dBase = Math.abs(b - m.ideal);
    const improved = dNow < dBase - 0.5, worse = dNow > dBase + 0.5;
    const diff = now - b, showDelta = eff > 0 && Math.abs(diff) >= 0.5;

    row.querySelector('.metric-val').textContent = String(Math.round(now));
    const fill = row.querySelector('.metric-fill');
    fill.style.width = (pct * 100).toFixed(1) + '%';
    fill.style.background = col;
    const delta = row.querySelector('.metric-delta');
    delta.classList.toggle('hidden', !showDelta);
    if (showDelta) {
      delta.textContent = (diff > 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(diff));
      delta.style.color = improved ? '#5f7d4e' : worse ? '#b3603f' : '#9a8571';
    }
  }

  if (scene) scene.sync(state, computeState);
}

render();

// ---------- three.js ----------
scene = new SkinScene(el.stageMount, {
  onReady: () => setState({ ready: true }),
  onPourTick: (patch) => setState(patch),
});
scene.sync(state, computeState);
