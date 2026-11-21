import { bandAndRankRange, farmEcon, farmSteps, gridNet, impliedValue, oddsDisplay, planFor, planTotalMinutes } from './model.js';
(function () {
'use strict';
var DATA = window.RADAR;
if (!DATA) return;
var app = document.getElementById('board');
var FIT = { a: DATA.model.fit_a, b: DATA.model.fit_b, n: DATA.model.fit_n, r2: DATA.model.fit_r2 };
var state = { q: '', category: 'all', chain: 'all', verdict: 'all', view: 'board', sort: 'implied', dir: -1, selected: null, anchors: true };
var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
function fmtUsd(n) {
if (n === null || n === undefined || !isFinite(n)) return 'n/a';
if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
return usd.format(n);
}
function fmtPct(n) {
if (n === null || n === undefined || !isFinite(n)) return 'n/a';
var v = n.toFixed(2);
if (v === '0.00' || v === '-0.00') return '0.00%';
return (n > 0 ? '+' : '') + v + '%';
}
function fmtSignedUsd(n) {
if (n === null || n === undefined || !isFinite(n)) return 'n/a';
return (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
}
function fmtAge(days) {
if (days === null || days === undefined) return 'unknown';
if (days >= 365) return (days / 365).toFixed(1) + 'y';
return Math.max(0, Math.round(days)) + 'd';
}
function el(tag, attrs) {
var node = document.createElement(tag);
if (attrs) {
Object.keys(attrs).forEach(function (k) {
if (k === 'class') node.className = attrs[k];
else if (k === 'text') node.textContent = attrs[k];
else if (k === 'html') node.innerHTML = attrs[k];
else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
});
}
for (var i = 2; i < arguments.length; i++) {
var child = arguments[i];
if (child === null || child === undefined) continue;
if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
else node.appendChild(child);
}
return node;
}
function deriveCheck() {
var bands = bandAndRankRange(DATA.rows, DATA.refits || []);
var ok = 0;
var bad = 0;
DATA.rows.forEach(function (r) {
var v = impliedValue(r, DATA.as_of, FIT);
var e = farmEcon(r, v.implied, v.age);
var b = bands.get(r.slug);
var steps = farmSteps(r, e, v.age, v.implied);
var plansOk = (r.farm_steps || []).length === steps.length && steps.every(function (s, i) { return s === r.farm_steps[i]; });
if (v.implied === r.implied_value_usd && e.verdict === r.verdict && e.net === r.econ.net && plansOk &&
b && b.band_lo_usd === r.band_lo_usd && b.band_hi_usd === r.band_hi_usd &&
b.rank_lo === r.rank_lo && b.rank_hi === r.rank_hi) ok++;
else bad++;
});
return { ok: ok, bad: bad };
}
var DERIVED = deriveCheck();
function looRow(variant) {
var rows = (DATA.validation && DATA.validation.loo) || [];
for (var i = 0; i < rows.length; i++) if (rows[i].variant === variant) return rows[i];
return null;
}
function readHash() {
var hash = window.location.hash.replace(/^#/, '');
if (!hash) return;
var params = new URLSearchParams(hash);
if (params.get('q')) state.q = params.get('q');
if (params.get('p')) state.selected = params.get('p');
if (params.get('category')) state.category = params.get('category');
if (params.get('chain')) state.chain = params.get('chain');
if (params.get('verdict')) state.verdict = params.get('verdict').split(',');
var sort = params.get('sort'); if (sort && ['implied', 'perhour', 'tvl', 'odds', 'name', 'growth', 'age'].indexOf(sort) >= 0) { state.sort = sort; state.dir = sort === 'odds' ? 1 : -1; }
var view = params.get('view'); if (view && ['board', 'live', 'method', 'setaside'].indexOf(view) >= 0) state.view = view;
}
function writeHash() {
var params = new URLSearchParams();
if (state.q) params.set('q', state.q);
if (state.category !== 'all') params.set('category', state.category);
if (state.chain !== 'all') params.set('chain', state.chain);
if (Array.isArray(state.verdict)) params.set('verdict', state.verdict.join(','));
else if (state.verdict !== 'all') params.set('verdict', state.verdict);
if (state.sort !== 'implied') params.set('sort', state.sort);
if (state.view !== 'board') params.set('view', state.view);
if (state.selected) params.set('p', state.selected);
var next = params.toString();
if (next) window.history.replaceState(null, '', '#' + next);
else window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
function rows() {
var q = state.q.trim().toLowerCase();
return DATA.rows.filter(function (r) {
if (state.category !== 'all' && r.category !== state.category) return false;
if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
if (state.verdict !== 'all' && (Array.isArray(state.verdict) ? state.verdict.indexOf(r.verdict) < 0 : r.verdict !== state.verdict)) return false;
if (!q) return true;
var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
return hay.indexOf(q) >= 0;
});
}
function sortedRows(list) {
var key = state.sort;
return list.slice().sort(function (a, b) {
var av, bv;
if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
else if (key === 'perhour') { av = a.econ.perHour; bv = b.econ.perHour; }
else if (key === 'odds') { av = a.econ.breakEvenOdds === null ? Infinity : a.econ.breakEvenOdds; bv = b.econ.breakEvenOdds === null ? Infinity : b.econ.breakEvenOdds; }
else { av = a.implied_value_usd; bv = b.implied_value_usd; }
if (av < bv) return -state.dir;
if (av > bv) return state.dir;
return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
});
}
function header() {
return el('header', { class: 'top' },
el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
el('div', { class: 'top-meta' },
el('span', { text: 'Snapshot ' + DATA.as_of }),
el('span', { text: 'DefiLlama protocol index' }),
el('span', { text: DATA.model_version + ' model' })
)
);
}
function hero() {
var flat = looRow('flat');
var full = looRow('curve+growth+maturity');
var ts = DATA.validation ? DATA.validation.time_split : null;
var bestFarm = DATA.rows.filter(function (r) { return r.verdict === 'FARM'; }).sort(function (a, b) { return b.econ.perHour - a.econ.perHour; }).slice(0, 3);
var watchlistCovered = DATA.watchlist.filter(function (s) { return DATA.rows.some(function (r) { return r.slug === s; }); }).length;
var counts = { FARM: 0, THIN: 0, SKIP: 0 };
DATA.rows.forEach(function (r) { counts[r.verdict]++; });
return el('section', { class: 'lede' },
el('div', null,
el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
el('p', { text: 'Value follows one curve fitted on the snapshot\u2019s own traded tokens: log\u2081\u2080(mcap) = ' + FIT.a.toFixed(2) + ' + ' + FIT.b.toFixed(3) + ' \u00d7 log\u2081\u2080(TVL / $100M), n = ' + FIT.n + ', R\u00b2 = ' + FIT.r2.toFixed(3) + '. A flat multiple pays big protocols far too much; the curve charges them the multiple their own size implies.' })
),
el('div', { class: 'facts' },
el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered · computed' }), el('b', { text: watchlistCovered + ' / ' + DATA.watchlist.length })),
el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
el('div', { class: 'fact' }, el('span', { text: 'Farm verdicts' }), el('b', { text: counts.FARM + ' farm / ' + counts.THIN + ' thin / ' + counts.SKIP + ' skip' }))
),
el('p', { class: 'evidence', text: 'LOO median miss ' + (full ? full.median_miss + '×' : 'n/a') + ' vs ' + (flat ? flat.median_miss + '×' : 'n/a') + ' flat · time split ' + (ts ? ts.curve_median_miss + '× (curve) vs ' + ts.flat_median_miss + '× (flat)' : 'n/a') + ' · re-derived ' + DERIVED.ok + ' of ' + DATA.board_size + ' rows' }),
el('div', { class: 'farm-cards' },
el('div', { class: 'farm-cards-label', text: 'Top 3 FARM by net $/h' }),
bestFarm.map(function (r) { return el('div', { class: 'farm-card' }, el('div', { class: 'farm-card-top' }, el('b', { text: r.name }), el('span', { class: 'verdict v-farm', text: 'FARM' })), el('span', { class: 'farm-card-nums', text: '$' + r.econ.perHour.toFixed(2) + '/h · $' + r.econ.deposit.toLocaleString('en-US') + ' deposit · ' + r.econ.holdDays + ' days · ' + oddsDisplay(r.econ.breakEvenOdds) + ' break-even' })); })),
scatter()
);
}
function controls() {
var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
var search = el('input', { type: 'search', id: 'q', placeholder: 'Search protocols', value: state.q, 'aria-label': 'Search the board' });
search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
el('option', { value: 'all', text: 'All categories' }),
categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
);
select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
var chains = [...new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))].sort();
var chain = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
el('option', { value: 'all', text: 'All chains' }),
chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
);
chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
function chip(v) {
var on = Array.isArray(state.verdict) ? state.verdict.indexOf(v) >= 0 : state.verdict === v;
return el('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', text: v, onclick: function () {
var cur = Array.isArray(state.verdict) ? state.verdict.slice() : (state.verdict === 'all' ? [] : [state.verdict]);
var i = cur.indexOf(v);
if (i >= 0) cur.splice(i, 1); else cur.push(v);
state.verdict = cur.length === 0 || cur.length === 3 ? 'all' : cur;
writeHash(); render();
} });
}
var verdict = el('div', { class: 'tabs', 'aria-label': 'Filter by farm verdict' }, ['FARM', 'THIN', 'SKIP'].map(chip));
function sortBtn(key, label, dir) {
return el('button', { type: 'button', 'aria-pressed': state.sort === key ? 'true' : 'false', text: label, onclick: function () { state.sort = key; state.dir = dir; writeHash(); render(); } });
}
var sort = el('div', { class: 'tabs', 'aria-label': 'Sort the board' },
[sortBtn('implied', 'Rank', -1), sortBtn('perhour', 'Net $/h', -1), sortBtn('tvl', 'TVL', -1), sortBtn('odds', 'Odds', 1)]
);
function tab(view, label) {
return el('button', { type: 'button', 'aria-pressed': state.view === view ? 'true' : 'false', text: label, onclick: function () { state.view = view; writeHash(); render(); } });
}
var anchors = el('label', { class: 'anchors' },
el('input', { type: 'checkbox', checked: state.anchors ? 'checked' : null, onclick: function (e) { state.anchors = e.target.checked; render(); } }),
' Traded anchors'
);
return el('div', { class: 'controls' },
el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chain),
el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Verdict' }), verdict),
el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Sort' }), sort),
el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, tab('board', 'Pre-token'), tab('live', 'Traded anchors'), tab('method', 'Method'), tab('setaside', 'Set aside'))),
state.view === 'method' ? null : anchors,
state.view === 'method' ? null : el('span', { class: 'sub', text: 'Net $/h assumes the token launches; the verdict also needs break-even odds ≤ threshold (FARM ≤10%, THIN ≤25%).' }),
el('span', { class: 'count', text: state.view === 'board' ? rows().length + ' rows shown' : state.view === 'live' ? DATA.live.length + ' traded anchors' : state.view === 'setaside' ? DATA.set_aside.length + ' set aside' : 'Method and backtest' })
);
}
function sortHeader(key, label) {
return el('th', { scope: 'col' },
el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
label,
state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▾' : ' ▴' }) : null
)
);
}
function boardRow(r, max) {
var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
var perHour = r.econ.perHour;
return el('tr', {
'data-selected': state.selected === r.slug ? 'true' : 'false',
tabindex: '0',
onclick: function () { openDetail(r.slug); },
onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
},
el('td', { class: 'num', text: String(r.rank) }),
el('td', null, el('div', { class: 'name' },
el('b', { text: r.name }),
el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.above_floor ? ' · above the floor' : '') })
)),
el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
el('td', { class: 'num ' + growthClass, text: growth }),
el('td', { class: 'num', text: fmtAge(r.age_days) }),
el('td', null, el('div', { class: 'implied' },
el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
el('span', { class: 'band', text: fmtUsd(r.band_lo_usd) + ' \u2013 ' + fmtUsd(r.band_hi_usd) + ' · rank ' + r.rank_lo + '\u2013' + r.rank_hi })
)),
el('td', null, el('span', { class: 'verdict v-' + r.verdict.toLowerCase(), text: r.verdict })),
el('td', { class: 'num ' + (perHour >= 0 ? 'pos' : 'neg'), text: (perHour >= 0 ? '$' : '\u2212$') + Math.abs(perHour).toFixed(0) + '/h' })
);
}
function anchorRow(a) {
return el('tr', { class: 'anchor' },
el('td', { class: 'num', text: 'anchor' }),
el('td', null, el('div', { class: 'name' },
el('b', { text: a.name }),
el('span', { class: 'sub', text: (a.category || 'Other') + ' · traded anchor' })
)),
el('td', { class: 'num', text: fmtUsd(a.tvl_usd) }),
el('td', { class: 'num', text: fmtPct(a.change_7d) }),
el('td', { class: 'num', text: '\u2014' }),
el('td', null, el('div', { class: 'implied' },
el('span', { class: 'num', text: fmtUsd(a.mcap_usd) }),
el('span', { class: 'band', text: 'curve ' + fmtUsd(a.curve_value_usd) + ' · \u00d7' + (a.multiple === null ? 'n/a' : Number(a.multiple.toFixed(2))) })
)),
el('td', null, el('span', { class: 'sub', text: '\u2014' })),
el('td', { class: 'num', text: '\u2014' })
);
}
function boardTable() {
var list = sortedRows(rows());
if (list.length === 0) {
return el('div', { class: 'panel' }, el('div', { class: 'empty' },
el('h2', { text: 'No protocol matches that filter' }),
el('p', { text: 'Clear the search or pick another category to see the board again.' }),
el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.sort = 'implied'; state.dir = -1; writeHash(); render(); } })
));
}
var max = list[0].implied_value_usd || 1;
var showAnchors = state.anchors && state.sort === 'implied' && state.dir === -1 && !state.q.trim() && state.category === 'all' && state.verdict === 'all';
var sortNames = { implied: 'implied value', perhour: 'net $/h', tvl: 'TVL', odds: 'break-even odds', name: 'name', growth: '7-day change', age: 'age' };
var orderText = (state.sort === 'implied' && state.dir === -1) ? 'strongest implied value first' : 'sorted by ' + (sortNames[state.sort] || state.sort) + (state.dir === 1 ? ', lowest first' : ', highest first');
var captionText = 'Pre-token protocols, ' + orderText + '. Band P25\u2013P75, rank range P10\u2013P90 (200 refits). ' + (showAnchors ? 'Tinted rows: traded anchors. ' : '') + '\u2018Above the floor\u2019: TVL \u2265 $50M, not a watchlist member. Select a row for its plan.';
var tbody = el('tbody');
var liveIdx = 0;
list.forEach(function (r, i) {
tbody.appendChild(boardRow(r, max));
if (showAnchors && (i + 1) % 6 === 0 && DATA.live.length > 0) {
tbody.appendChild(anchorRow(DATA.live[liveIdx % DATA.live.length]));
liveIdx++;
}
});
return el('div', { class: 'panel' },
el('div', { class: 'table-wrap' },
el('table', null,
el('caption', { class: 'sub', text: captionText }),
el('thead', null, el('tr', null,
sortHeader('implied', 'Rank'),
sortHeader('name', 'Protocol'),
sortHeader('tvl', 'TVL'),
sortHeader('growth', '7d'),
sortHeader('age', 'Age'),
sortHeader('implied', 'Implied value'),
el('th', { scope: 'col', text: 'Verdict' }),
sortHeader('perhour', 'Net $/h')
)),
tbody
)
)
);
}
function liveTable() {
var tbody = el('tbody');
DATA.live.forEach(function (r) {
tbody.appendChild(el('tr', null,
el('td', { class: 'num', text: 'anchor' }),
el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
el('td', { class: 'num', text: fmtUsd(r.curve_value_usd) }),
el('td', { class: 'num', text: r.multiple === null ? 'n/a' : '\u00d7' + Number(r.multiple.toFixed(2)) }),
el('td', null, el('span', { class: 'status', text: 'traded anchor' }))
));
});
return el('div', { class: 'panel' },
el('div', { class: 'table-wrap' },
el('table', null,
el('caption', { class: 'sub', text: 'Tokens live: these protocols already trade, so their market cap is a fact, not a model. The curve value is what the curve would pay for their TVL; the multiple is market cap over TVL. They are set aside from the pre-token ranking.' }),
el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Curve value' }), el('th', { scope: 'col', text: '\u00d7 TVL' }), el('th', { scope: 'col', text: 'Token' }))),
tbody
)
)
);
}
function num(x) {
return x === null || x === undefined ? 'n/a' : String(x);
}
function scatter() {
var W = 620, H = 340, ML = 48, MR = 14, MT = 12, MB = 36;
var xs = DATA.fit_points.map(function (p) { return p.x; }).concat(DATA.rows.map(function (r) { return Math.log10(r.tvl_usd / 1e8); }));
var ys = DATA.fit_points.map(function (p) { return p.y; }).concat(DATA.rows.map(function (r) { return Math.log10(Math.max(1, r.implied_value_usd)); }));
var x0 = Math.min.apply(null, xs) - 0.2, x1 = Math.max.apply(null, xs) + 0.2;
var y0 = Math.min.apply(null, ys) - 0.2, y1 = Math.max.apply(null, ys) + 0.2;
function X(x) { return ML + (x - x0) / (x1 - x0) * (W - ML - MR); }
function Y(y) { return H - MB - (y - y0) / (y1 - y0) * (H - MT - MB); }
var line = '<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(FIT.a + FIT.b * x0).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(FIT.a + FIT.b * x1).toFixed(1) + '" class="fit-line"/>';
var dots = DATA.fit_points.map(function (p) { return '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.5" class="dot-fit"/>'; }).join('');
var rows = DATA.rows.map(function (r) { return '<circle cx="' + X(Math.log10(r.tvl_usd / 1e8)).toFixed(1) + '" cy="' + Y(Math.log10(Math.max(1, r.implied_value_usd))).toFixed(1) + '" r="2" class="dot-row"/>'; }).join('');
var ticks = '';
[-2, -1, 0, 1].forEach(function (t) {
if (t < x0 || t > x1) return;
ticks += '<line x1="' + X(t).toFixed(1) + '" y1="' + (H - MB) + '" x2="' + X(t).toFixed(1) + '" y2="' + (H - MB + 5) + '" class="tick"/><text x="' + X(t).toFixed(1) + '" y="' + (H - MB + 18) + '" class="axis">' + ['$1M', '$10M', '$100M', '$1B'][t + 2] + '</text>';
});
[5, 6, 7, 8, 9].forEach(function (t) {
if (t < y0 || t > y1) return;
ticks += '<line x1="' + (ML - 5) + '" y1="' + Y(t).toFixed(1) + '" x2="' + ML + '" y2="' + Y(t).toFixed(1) + '" class="tick"/><text x="' + (ML - 9) + '" y="' + (Y(t) + 4).toFixed(1) + '" class="axis" text-anchor="end">$' + ['100K', '1M', '10M', '100M', '1B'][t - 5] + '</text>';
});
var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of traded comps and board rows against the fitted curve">' +
'<rect x="' + ML + '" y="' + MT + '" width="' + (W - ML - MR) + '" height="' + (H - MT - MB) + '" class="plot"/>' +
line + dots + rows + ticks +
'<text x="' + (W / 2) + '" y="' + (H - 4) + '" class="axis" text-anchor="middle">TVL (log scale)</text>' +
'<text x="12" y="' + (H / 2) + '" class="axis" text-anchor="middle" transform="rotate(-90 12 ' + (H / 2) + ')">Market cap / implied value (log scale)</text></svg>';
return el('div', { class: 'scatter' },
el('div', { class: 'html', html: svg }),
el('p', { class: 'sub', text: 'Dark dots: the ' + FIT.n + ' traded comps the curve is fitted on. Amber dots: the board’s rows at their implied values. The line is the fitted curve.' })
);
}
function planTimeline(plan, hold) {
var days = Array.from(new Set(plan.map(function (s) { return s.day; }))).sort(function (a, b) { return a - b; });
var max = Math.max.apply(null, days.concat([hold, 1]));
var x = function (d) { return 24 + (d / max) * 412; };
var dots = days.map(function (d) { return '<circle cx="' + x(d).toFixed(1) + '" cy="14" r="4"/><text x="' + x(d).toFixed(1) + '" y="36" text-anchor="middle">Day ' + d + '</text>'; }).join('');
return '<svg viewBox="0 0 460 44" role="img" aria-label="Farm plan timeline"><line x1="24" y1="14" x2="436" y2="14"/>' + dots + '</svg>';
}
function sensitivityGrid(e) {
var h = '<p class="sub">Net by drawdown and deposit:</p><table class="grid"><tr><th></th><th>$1K</th><th>$5K</th><th>$10K</th></tr>';
[5, 10, 20].forEach(function (d) {
h += '<tr><th>' + d + '% down</th>';
[1000, 5000, 10000].forEach(function (p) { h += '<td class="num">' + fmtSignedUsd(gridNet(e, p, d / 100)) + '</td>'; });
h += '</tr>';
});
return h + '</table>';
}
function methodView() {
var loo = (DATA.validation && DATA.validation.loo) || [];
var ts = DATA.validation ? DATA.validation.time_split : null;
var flat = looRow('flat'), full = looRow('curve+growth+maturity');
var u = DATA.universe;
var reasons = Object.keys(u.set_aside_by_reason).map(function (k) { return u.set_aside_by_reason[k] + ' ' + (k === 'name shared with a traded token' ? 'names shared with a traded token' : k + 's'); }).join(', ');
var notes = 'The curve beats the flat multiple out of sample (' + (full ? full.median_miss + '\u00d7' : 'n/a') + ' vs ' + (flat ? flat.median_miss + '\u00d7' : 'n/a') + ' median miss). Growth adds almost nothing; maturity adds a little on median but not within 2\u00d7. The order comes mostly from TVL \u2014 the curve earns its keep on the level, not the order. Category effects were fitted and left out: on walk-forward folds they do not beat the bare curve.';
var tbody = el('tbody');
loo.forEach(function (r) {
tbody.appendChild(el('tr', null,
el('td', { text: r.variant }),
el('td', { class: 'num', text: String(r.n) }),
el('td', { class: 'num', text: r.median_miss + '\u00d7' }),
el('td', { class: 'num', text: (r.within_2x * 100).toFixed(1) + '%' }),
el('td', { class: 'num', text: (r.within_3x * 100).toFixed(1) + '%' }),
el('td', { class: 'num', text: num(r.rank_corr) })
));
});
return el('div', null,
el('section', { class: 'panel model' },
el('h2', { text: 'How the model is tested' }),
el('p', { class: 'sub', text: 'Leave-one-out: each variant refits without the token it predicts, so the miss is out of sample.' }),
el('div', { class: 'table-wrap' },
el('table', null,
el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Variant' }), el('th', { scope: 'col', text: 'n' }), el('th', { scope: 'col', text: 'Median miss' }), el('th', { scope: 'col', text: 'Within 2\u00d7' }), el('th', { scope: 'col', text: 'Within 3\u00d7' }), el('th', { scope: 'col', text: 'Rank corr' }))),
tbody
)
),
el('p', { class: 'sub', text: ts ? 'Time split: ' + ts.train_n + ' comps listed before 2024 (train), ' + ts.test_n + ' after (test), ' + (FIT.n - ts.train_n - ts.test_n) + ' undated: curve ' + ts.curve_median_miss + '\u00d7 vs flat ' + ts.flat_median_miss + '\u00d7 median miss.' : 'Time split: too few dated comps to split.' }),
el('p', { class: 'sub', text: notes }),
el('p', { class: 'sub', text: 'Universe: ' + (u.ranked + u.set_aside + u.recorded_with_token + u.traded) + ' protocols in the snapshot: ' + u.ranked + ' ranked, ' + u.set_aside + ' set aside (' + reasons + '), ' + u.recorded_with_token + ' have a token but no market cap, ' + u.traded + ' already trade. Uncertainty: every row carries its P25\u2013P75 band and P10\u2013P90 rank range (200 refits).' }),
el('p', { class: 'sub', text: 'Plan assumptions: 10% of the implied value reaches farmers; gas is the cheapest of the first three chains; 4 transactions per plan; capital at 4% a year; deposit $500 or $5,000; hold 30 to 60 days by protocol age. Ten rows use the generic deposit and weekly fallback. The $5,000 cap is a farm-budget scenario, not a measured figure. Grid: net at 5/10/20% drawdown × $1K/5K/10K; slice and capital scale, fees fixed. Stop: unwind if TVL falls 2× the 7-day move (10-35%); if the protocol pauses withdrawals or the exit freezes, wait and recheck weekly.' })
)
);
}
function setAsideView() {
var tbody = el('tbody');
DATA.set_aside.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd; }).forEach(function (s) {
tbody.appendChild(el('tr', null,
el('td', null, el('b', { text: s.name })),
el('td', { text: s.reason }),
el('td', { class: 'num', text: fmtUsd(s.tvl_usd) })
));
});
return el('div', { class: 'panel' },
el('div', { class: 'table-wrap' },
el('table', null,
el('caption', { class: 'sub', text: 'Pre-token protocols the board does not rank, each with its reason. The watchlist is never set aside: it is the floor.' }),
el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Reason' }), el('th', { scope: 'col', text: 'TVL' }))),
tbody
)
)
);
}
var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
function openDetail(slug) {
var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
if (!row) return;
state.selected = slug;
writeHash();
dialog.textContent = '';
var plan = planFor(row, row.econ, row.age_days, row.implied_value_usd);
var recomputed = impliedValue(row, DATA.as_of, FIT);
var peers = DATA.live.map(function (l) {
return { l: l, d: Math.abs(Math.log10(Math.max(1, l.curve_value_usd) / Math.max(1, row.implied_value_usd))) };
}).sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
var e = row.econ;
function netAt(k) { return fmtSignedUsd(k * e.slice - e.fees - e.capitalCost); }
dialog.appendChild(el('div', { class: 'detail-head' },
el('div', null,
el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
el('h2', { id: 'detail-title', text: row.name }),
el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
),
el('span', { class: 'verdict v-' + row.verdict.toLowerCase(), text: row.verdict }),
el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
));
dialog.appendChild(el('section', { class: 'detail-section' },
el('h3', { text: row.verdict === 'SKIP' ? 'Why SKIP' : 'Farm plan' }),
el('div', { class: 'arith', text: 'Slice $' + e.slice.toFixed(2) + ' − fees $' + e.fees.toFixed(2) + ' − capital $' + e.capitalCost.toFixed(2) + ' = net ' + fmtSignedUsd(e.net) }),
el('p', { class: 'sub', text: 'Slice is 10% × $' + row.implied_value_usd.toLocaleString('en-US') + ' × $' + e.deposit.toLocaleString('en-US') + ' / $' + row.tvl_usd.toLocaleString('en-US') + '. Odds ' + oddsDisplay(e.breakEvenOdds) + ' · ' + (e.minDeposit === null ? 'No deposit pays' : 'Min deposit $' + e.minDeposit.toLocaleString('en-US')) + '.' }),
el('div', { class: 'table-wrap' },
el('table', { class: 'plan' },
el('thead', null, el('tr', null, ['Day', 'Action', 'Where', 'Amount', 'Cost', 'Time'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
el('tbody', null, plan.map(function (s) {
return el('tr', null,
el('td', { class: 'num', text: 'Day ' + s.day }),
el('td', { text: s.action }),
el('td', { text: s.where }),
el('td', { class: 'num', text: s.amount }),
el('td', { class: 'num', text: s.cost }),
el('td', { class: 'num', text: s.time }));
})),
el('tfoot', null, el('tr', null, el('td', { colspan: 4, text: 'Total net '+fmtSignedUsd(e.net) }), el('td', { class: 'num', text: '$'+(row.verdict === 'SKIP' ? 0 : e.fees).toFixed(2) }), el('td', { class: 'num', text: Math.round(planTotalMinutes(plan)) + ' min' })))
)
),
el('h3', { text: row.verdict === 'SKIP' ? 'Economics' : 'Farm economics' }),
el('div', { class: 'equation' },
el('div', null, el('span', { text: row.verdict === 'SKIP' ? 'Deposit if it paid (' + e.chain + ')' : 'Deposit (' + e.chain + ')' }), el('b', { class: 'num', text: '$' + e.deposit.toLocaleString('en-US') })),
el('div', null, el('span', { text: 'Expected slice (10% share)' }), el('b', { class: 'num', text: '$' + e.slice.toFixed(2) })),
el('div', null, el('span', { text: 'Fees (gas, ' + e.holdDays + ' days)' }), el('b', { class: 'num', text: '$' + e.fees.toFixed(2) })),
el('div', null, el('span', { text: 'Capital cost (4% T-bill)' }), el('b', { class: 'num', text: '$' + e.capitalCost.toFixed(2) })),
el('div', null, el('span', { text: 'Net' }), el('b', { class: 'num', text: fmtSignedUsd(e.net) })),
el('div', null, el('span', { text: 'Break-even odds' }), el('b', { class: 'num', text: oddsDisplay(e.breakEvenOdds) })),
el('div', null, el('span', { text: 'Net $/h' }), el('b', { class: 'num', text: '$' + e.perHour.toFixed(2) })),
el('div', null, el('span', { text: 'Minimum deposit that pays' }), el('b', { class: 'num', text: e.minDeposit === null ? 'no deposit pays' : '$' + e.minDeposit.toLocaleString('en-US') }))
),
el('div', { html: sensitivityGrid(e) }),
el('p', { class: 'sub', text: 'Sensitivity: 20% low, net ' + netAt(0.8) + '; 10% low, ' + netAt(0.9) + '; as stated, ' + netAt(1) + '. FARM max 10% odds, THIN max 25%.' }),
el('div', { class: 'timeline', html: planTimeline(plan, e.holdDays) }),
el('p', { class: 'sub', text: 'Hands-on hours (' + e.activeHours.toFixed(2) + 'h here) = setup + weekly review + exit, matching the step minutes.' })
));
dialog.appendChild(el('section', { class: 'detail-section' },
el('h3', { text: 'Implied value' }),
el('div', { class: 'equation' },
el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
el('div', null, el('span', { text: 'Curve value' }), el('b', { class: 'num', text: fmtUsd(row.curve_value_usd) })),
el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
el('div', null, el('span', { text: 'Uncertainty band (P25\u2013P75)' }), el('b', { class: 'num', text: fmtUsd(row.band_lo_usd) + ' \u2013 ' + fmtUsd(row.band_hi_usd) })),
el('div', null, el('span', { text: 'Rank range (P10\u2013P90)' }), el('b', { class: 'num', text: '#' + row.rank_lo + '\u2013#' + row.rank_hi }))
),
el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed.implied) + (recomputed.implied === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' }),
el('p', { class: 'sub', text: 'Nearest traded peers by curve value: ' + peers.map(function (p) { return p.l.name + ' (' + fmtUsd(p.l.mcap_usd) + ', \u00d7' + (p.l.multiple === null ? 'n/a' : Number(p.l.multiple.toFixed(2))) + ')'; }).join(', ') + '.' })
));
if (typeof dialog.showModal === 'function') {
if (!dialog.open) dialog.showModal();
} else {
dialog.setAttribute('open', '');
}
}
function render() {
app.textContent = '';
var shell = el('div', { class: 'shell' });
shell.appendChild(header());
shell.appendChild(hero());
shell.appendChild(controls());
if (state.view === 'board') shell.appendChild(boardTable());
else if (state.view === 'live') shell.appendChild(liveTable());
else if (state.view === 'method') shell.appendChild(methodView());
else shell.appendChild(setAsideView());
app.appendChild(shell);
app.setAttribute('aria-busy', 'false');
if (!dialog.isConnected) app.appendChild(dialog);
if (state.selected) openDetail(state.selected);
}
readHash();
render();
window.addEventListener('keydown', function (e) {
if (e.key === 'Escape' && dialog.open) dialog.close();
});
})();
