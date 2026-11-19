/* Token Radar — offline dashboard logic. No framework, no network, no fetch.
   Reads window.RADAR (written to ../data.js by main.ts from the same board.json),
   renders a sortable/filterable board, a separate already-trading view, a model
   explainer, and a detail drawer for every protocol with its value breakdown and
   farm plan. All DOM is built with textContent, so no data is ever parsed as HTML. */
'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);

/* ---------- formatting ---------- */
function usd(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
function usdFull(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function pct(n) {
  if (n === null || n === undefined) return '—';
  const s = n > 0 ? '+' : '';
  return s + n.toFixed(2) + '%';
}
function gClass(n) {
  if (n === null || n === undefined) return 'flat';
  return n > 0.005 ? 'up' : n < -0.005 ? 'down' : 'flat';
}
function ageText(d) {
  if (d === null || d === undefined) return 'unknown';
  if (d < 60) return d + 'd';
  if (d < 730) return Math.round(d / 30) + 'mo';
  return (d / 365).toFixed(1) + 'y';
}

/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    if (k === 'class') el.className = props[k];
    else if (k === 'text') el.textContent = props[k];
    else if (k.startsWith('on') && typeof props[k] === 'function') el.addEventListener(k.slice(2), props[k]);
    else if (props[k] !== null && props[k] !== undefined) el.setAttribute(k, props[k]);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ---------- state ---------- */
const state = {
  tab: 'board',
  q: '',
  cat: '',
  chain: '',
  scope: 'all',
  sortKey: 'rank',
  sortDir: 1,
  selected: null,
};
const wl = new Set(R.watchlist);

/* ---------- columns ---------- */
const BOARD_COLS = [
  { key: 'rank', label: '#', num: true },
  { key: 'name', label: 'Protocol' },
  { key: 'category', label: 'Category' },
  { key: 'chains', label: 'Chains' },
  { key: 'tvl_usd', label: 'TVL', num: true },
  { key: 'change_7d', label: '7d', num: true },
  { key: 'age_days', label: 'Tokenless age', num: true },
  { key: 'implied_value_usd', label: 'Implied value', num: true },
];
const LIVE_COLS = [
  { key: 'name', label: 'Protocol' },
  { key: 'category', label: 'Category' },
  { key: 'chains', label: 'Chains' },
  { key: 'tvl_usd', label: 'TVL', num: true },
  { key: 'mcap_usd', label: 'Market cap', num: true },
  { key: 'mcap_tvl', label: 'Cap / TVL', num: true },
  { key: 'change_7d', label: '7d', num: true },
];

/* ---------- filtering + sorting ---------- */
function activeRows() {
  return state.tab === 'live' ? R.live : R.rows;
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  let rows = activeRows().filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))) return false;
    if (state.cat && (r.category ?? 'Uncategorized') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.tab === 'board') {
      if (state.scope === 'watchlist' && !wl.has(r.slug)) return false;
      if (state.scope === 'early' && wl.has(r.slug)) return false;
    }
    return true;
  });
  const k = state.sortKey, dir = state.sortDir;
  rows = [...rows].sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === 'name' || k === 'category') {
      av = (av ?? '').toString().toLowerCase(); bv = (bv ?? '').toString().toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    if (k === 'chains') { av = a.chains.length; bv = b.chains.length; }
    av = av === null || av === undefined ? -Infinity : av;
    bv = bv === null || bv === undefined ? -Infinity : bv;
    return (av - bv) * dir || (a.slug < b.slug ? -1 : 1);
  });
  return rows;
}

/* ---------- header / stats / filters ---------- */
function initChrome() {
  $('asof').textContent = 'snapshot ' + R.as_of;
  $('modelver').textContent = 'model ' + R.model_version;
  $('source-line').textContent = 'Source: ' + R.source;

  const s = R.stats;
  const stats = [
    { b: s.board, span: 'ranked pre-token rows', accent: true },
    { b: s.watchlist + '/' + s.watchlist, span: 'watchlist covered' },
    { b: s.early, span: 'early finds below floor' },
    { b: s.live, span: 'already-trading set' },
    { b: usd(R.floor_usd), span: 'watchlist TVL floor' },
    { b: s.protocols, span: 'protocols in snapshot' },
  ];
  $('stats').replaceChildren(...stats.map((x) =>
    h('div', { class: 'stat' + (x.accent ? ' accent' : '') }, h('b', { text: String(x.b) }), h('span', { text: x.span }))));

  const cats = [...new Set([...R.rows, ...R.live].map((r) => r.category ?? 'Uncategorized'))].sort();
  $('fcat').replaceChildren(h('option', { value: '', text: 'All categories' }), ...cats.map((c) => h('option', { value: c, text: c })));
  const chains = [...new Set([...R.rows, ...R.live].flatMap((r) => r.chains))].sort();
  $('fchain').replaceChildren(h('option', { value: '', text: 'All chains' }), ...chains.map((c) => h('option', { value: c, text: c })));
}

/* ---------- table ---------- */
function chainCell(chains) {
  const show = chains.slice(0, 3);
  const kids = show.map((c) => h('span', { class: 'chain', text: c }));
  if (chains.length > 3) kids.push(h('span', { class: 'chain more', text: '+' + (chains.length - 3) }));
  if (chains.length === 0) kids.push(h('span', { class: 'chain more', text: '—' }));
  return h('div', { class: 'chains' }, kids);
}
function nameCell(r, isLive) {
  const star = !isLive && wl.has(r.slug) ? h('span', { class: 'star', title: 'On the watchlist', text: '★' }) : null;
  return h('div', {}, h('span', { class: 'pname', text: r.name }), star, h('span', { class: 'pslug', text: r.slug }));
}
function cell(r, col, isLive) {
  switch (col.key) {
    case 'rank': return h('td', { class: 'num rank', text: String(r.rank) });
    case 'name': return h('td', {}, nameCell(r, isLive));
    case 'category': return h('td', { class: 'cat', text: r.category ?? 'Uncategorized' });
    case 'chains': return h('td', {}, chainCell(r.chains));
    case 'tvl_usd': return h('td', { class: 'num', text: usd(r.tvl_usd) });
    case 'mcap_usd': return h('td', { class: 'num val', text: usd(r.mcap_usd) });
    case 'mcap_tvl': return h('td', { class: 'num', text: r.mcap_tvl === null ? '—' : r.mcap_tvl.toFixed(2) + '×' });
    case 'change_7d': return h('td', { class: 'num g ' + gClass(r.change_7d), text: pct(r.change_7d) });
    case 'age_days': return h('td', { class: 'num age', text: ageText(r.age_days) });
    case 'implied_value_usd': return h('td', { class: 'num val', text: usd(r.implied_value_usd) });
    default: return h('td', {});
  }
}
function renderTable() {
  const isLive = state.tab === 'live';
  const cols = isLive ? LIVE_COLS : BOARD_COLS;
  const rows = filtered();

  $('thead').replaceChildren(h('tr', {}, cols.map((c) => {
    const arrow = state.sortKey === c.key ? h('span', { class: 'arrow', text: state.sortDir > 0 ? '▲' : '▼' }) : null;
    return h('th', {
      class: c.num ? 'num' : '', scope: 'col', tabindex: '0', role: 'columnheader',
      'aria-sort': state.sortKey === c.key ? (state.sortDir > 0 ? 'ascending' : 'descending') : 'none',
      onclick: () => sortBy(c.key),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(c.key); } },
    }, c.label, arrow);
  })));

  $('tbody').replaceChildren(...rows.map((r) => h('tr', {
    tabindex: '0', role: 'button', 'aria-label': 'Open ' + r.name,
    onclick: () => openDetail(r.slug, isLive ? 'live' : 'board'),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug, isLive ? 'live' : 'board'); } },
  }, cols.map((c) => cell(r, c, isLive)))));

  $('empty').hidden = rows.length !== 0;
  $('table').hidden = rows.length === 0;
  $('count').textContent = rows.length + ' of ' + activeRows().length + (isLive ? ' trading' : ' rows');
}
function sortBy(key) {
  if (state.sortKey === key) state.sortDir *= -1;
  else { state.sortKey = key; state.sortDir = (key === 'name' || key === 'category') ? 1 : (key === 'rank' ? 1 : -1); }
  renderTable();
}

/* ---------- detail drawer ---------- */
function parseStep(s) {
  const ci = s.indexOf(' Cost: ');
  if (ci < 0) return { text: s, cost: null, time: null };
  const text = s.slice(0, ci);
  const rest = s.slice(ci + 7);
  const ti = rest.lastIndexOf('. Time: ');
  if (ti < 0) return { text, cost: rest.replace(/\.$/, ''), time: null };
  return { text, cost: rest.slice(0, ti), time: rest.slice(ti + 8).replace(/\.$/, '') };
}
function bar(label, value, lo, hi, fmt) {
  const frac = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return h('div', { class: 'brow' },
    h('span', { class: 'bk', text: label }),
    h('div', { class: 'bar' }, h('i', { style: 'width:' + (frac * 100).toFixed(1) + '%' })),
    h('span', { class: 'bv', text: fmt(value) }));
}
function dcell(k, v) {
  return h('div', { class: 'dcell' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
}
function farmList(steps) {
  return h('ol', { class: 'steps' }, steps.map((s) => {
    const p = parseStep(s);
    const ct = [];
    if (p.cost) ct.push(h('span', { class: 'cost', text: 'Cost: ' + p.cost }));
    if (p.time) ct.push(h('span', { class: 'time', text: 'Time: ' + p.time }));
    return h('li', {}, h('div', { text: p.text }), ct.length ? h('div', { class: 'ct' }, ct) : null);
  }));
}
function openDetail(slug, kind) {
  const r = (kind === 'live' ? R.live : R.rows).find((x) => x.slug === slug);
  if (!r) return;
  state.selected = slug;
  const isLive = kind === 'live';
  const d = $('detail');

  const head = h('div', {},
    h('button', { class: 'close', type: 'button', 'aria-label': 'Close detail', onclick: closeDetail, text: '×' }),
    h('h2', { text: r.name }),
    h('div', { class: 'dslug', text: r.slug }),
    h('div', { class: 'dhead' },
      h('span', { class: 'badge ' + (isLive ? 'live' : 'pre'), text: isLive ? 'Token trading' : 'Pre-token' }),
      h('span', { class: 'cat', text: r.category ?? 'Uncategorized' }),
      !isLive && wl.has(r.slug) ? h('span', { class: 'star', text: '★ watchlist' }) : null),
    chainCell(r.chains));

  const valueBox = isLive
    ? h('div', { class: 'dvalue' },
        h('div', { class: 'lbl', text: 'Market cap (the market’s own value)' }),
        h('div', { class: 'big', text: usdFull(r.mcap_usd) }),
        h('div', { class: 'lbl', text: 'Cap / TVL ' + (r.mcap_tvl === null ? '—' : r.mcap_tvl.toFixed(2) + '×') + ' · symbol ' + (r.symbol ?? '—') }))
    : h('div', { class: 'dvalue' },
        h('div', { class: 'lbl', text: 'Implied launch value (radar’s claim)' }),
        h('div', { class: 'big', text: usdFull(r.implied_value_usd) }),
        h('div', { class: 'lbl', text: 'Rank #' + r.rank + ' of ' + R.stats.board }));

  const grid = h('div', { class: 'dgrid' },
    dcell('TVL', usdFull(r.tvl_usd)),
    dcell('7d TVL change', pct(r.change_7d)),
    dcell('Listed', r.listed_at ?? 'unknown'),
    dcell('Tokenless age', ageText(r.age_days)));

  let breakdown = null, formula = null;
  if (!isLive) {
    const m = r.model;
    grid.append(
      dcell('Sector multiple', m.sector_multiple.toFixed(4) + '× (' + (m.sector_fallback ? 'global fallback' : m.sector_peers + ' peers') + ')'),
      dcell('Base = TVL × sector', usdFull(m.base_usd)));
    breakdown = h('div', {},
      h('div', { class: 'dsection', text: 'Value model breakdown' }),
      h('div', { class: 'break' },
        bar('Sector ×', m.sector_multiple, R.model.multiple_floor, R.model.multiple_cap, (v) => v.toFixed(3) + '×'),
        bar('Momentum', m.momentum, 1 + R.model.growth_floor / 100 * R.model.growth_weight, 1 + R.model.growth_cap / 100 * R.model.growth_weight, (v) => v.toFixed(3) + '×'),
        bar('Seasoning', m.seasoning, R.model.seasoning_floor, R.model.seasoning_floor + R.model.seasoning_range, (v) => v.toFixed(3) + '×'),
        bar('Breadth', m.breadth, 1, 1 + R.model.breadth_cap * R.model.breadth_step, (v) => v.toFixed(3) + '×')),
      h('div', { class: 'formula', text: 'implied = ' + usd(r.tvl_usd) + ' × ' + m.sector_multiple.toFixed(4) + ' × ' + m.momentum.toFixed(3) + ' × ' + m.seasoning.toFixed(3) + ' × ' + m.breadth.toFixed(3) + ' = ' + usdFull(r.implied_value_usd) }));
  }

  const plan = h('div', {},
    h('div', { class: 'dsection', text: isLive ? 'Post-token plan (stake / LP / govern)' : 'Farm plan (pre-launch)' }),
    farmList(r.farm_steps));

  d.replaceChildren(head, valueBox, grid, breakdown, formula, plan);
  d.hidden = false;
  $('backdrop').hidden = false;
  d.querySelector('.close').focus();
}
function closeDetail() {
  state.selected = null;
  $('detail').hidden = true;
  $('backdrop').hidden = true;
}

/* ---------- model view ---------- */
function renderModel() {
  const m = R.model, a = R.anchor;
  const sectors = Object.entries(a.sectors).sort((x, y) => y[1].peers - x[1].peers || (x[0] < y[0] ? -1 : 1));
  const v = $('model-view');
  v.replaceChildren(
    h('h2', { text: 'How the implied value is derived' }),
    h('p', { text: 'Every figure comes from the sealed snapshot itself — no hardcoded protocol names, no network, no randomness. The board ranks only pre-token protocols (mcap, gecko_id and symbol all null). Already-trading protocols are shown separately at the market’s own cap.' }),
    h('h3', { text: 'The formula' }),
    h('pre', { text:
      'sectorMultiple = clamp( median(mcap_usd / tvl_usd) of same-category TRADING peers, ' + m.multiple_floor + ', ' + m.multiple_cap + ' )\n' +
      '                 (needs >= ' + m.min_peers + ' peers, else the global median ' + a.global_median + '× over ' + a.global_peers + ' trading protocols)\n' +
      'base           = tvl_usd × sectorMultiple\n' +
      'momentum       = 1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ')/100 × ' + m.growth_weight + '\n' +
      'seasoning      = ' + m.seasoning_floor + ' + min(age_days, ' + m.seasoning_days + ')/' + m.seasoning_days + ' × ' + m.seasoning_range + '   (age = as_of − listed_at; unknown → ' + m.unknown_age_days + 'd)\n' +
      'breadth        = 1 + min(chains − 1, ' + m.breadth_cap + ') × ' + m.breadth_step + '\n' +
      'implied        = clamp(round(base × momentum × seasoning × breadth), 1, 1e14)' }),
    h('h3', { text: 'Why each factor' }),
    h('p', { text: 'Sector multiple: the snapshot reveals what the market pays per dollar of TVL in each sector, so the anchor follows from the data rather than a guessed constant. Momentum: a protocol growing TVL is compounding its future fee base; the asymmetric clamp stops one freak spike inventing value. Seasoning: a long tokenless track record means more accrued airdrop debt and a proven product. Breadth: more chains means a wider distribution surface for a future token, capped so it never outranks real TVL.' }),
    h('h3', { text: 'Sector multiples from this snapshot' }),
    h('table', { class: 'sector-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Category' }), h('th', { class: 'num', text: 'Multiple' }), h('th', { class: 'num', text: 'Trading peers' }), h('th', { text: 'Source' }))),
      h('tbody', {}, sectors.map(([cat, s]) => h('tr', {},
        h('td', { text: cat }),
        h('td', { class: 'num', text: s.multiple.toFixed(4) + '×' }),
        h('td', { class: 'num', text: String(s.peers) }),
        h('td', { class: 'fb', text: s.fallback ? 'global fallback' : 'category median' }))))),
    h('h3', { text: 'Board selection' }),
    h('p', { text: 'Every watchlist slug (the floor, never the ceiling) plus every rankable pre-token protocol below the ' + usd(R.floor_usd) + ' floor, by TVL. Rankable applies the house hygiene: not CEX, not a Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC product, no version-marker name, no whole word wrapped / staked / staking — so the early rows are genuine launches, not wrapped products of a token that already trades.' }));
}

/* ---------- tabs / view switching ---------- */
function setTab(tab) {
  state.tab = tab;
  for (const t of ['board', 'live', 'model']) {
    const btn = $('tab-' + t);
    btn.classList.toggle('is-on', t === tab);
    btn.setAttribute('aria-selected', String(t === tab));
  }
  const isModel = tab === 'model';
  $('toolbar').hidden = isModel;
  $('table-wrap').hidden = isModel;
  $('model-view').hidden = !isModel;
  $('scope-wrap').hidden = tab !== 'board';
  if (isModel) { renderModel(); return; }
  // sensible default sort per tab
  state.sortKey = tab === 'live' ? 'mcap_usd' : 'rank';
  state.sortDir = tab === 'live' ? -1 : 1;
  renderTable();
}

/* ---------- events ---------- */
function initEvents() {
  for (const t of ['board', 'live', 'model']) $('tab-' + t).addEventListener('click', () => setTab(t));
  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('fcat').addEventListener('change', (e) => { state.cat = e.target.value; renderTable(); });
  $('fchain').addEventListener('change', (e) => { state.chain = e.target.value; renderTable(); });
  $('fscope').addEventListener('change', (e) => { state.scope = e.target.value; renderTable(); });
  $('reset').addEventListener('click', () => {
    state.q = ''; state.cat = ''; state.chain = ''; state.scope = 'all';
    $('q').value = ''; $('fcat').value = ''; $('fchain').value = ''; $('fscope').value = 'all';
    state.sortKey = state.tab === 'live' ? 'mcap_usd' : 'rank';
    state.sortDir = state.tab === 'live' ? -1 : 1;
    renderTable();
  });
  $('backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDetail(); });
}

/* ---------- boot ---------- */
initChrome();
initEvents();
setTab('board');
