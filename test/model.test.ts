// Tests for the token radar's model (lib/model.ts): the implied-value formula, the farm
// plans, the board builder, the snapshot parser and the board gate. Every expectation
// below is computed from the model's own stated constants, not from a run's output:
// a test that only repeats what the code printed would prove nothing.
//
// Run: node --test test/model.test.ts (Node 22.18+; the file imports no test dependency).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL,
  MODEL_VERSION,
  EARLY_ROWS,
  LIVE_ROWS,
  SnapshotError,
  ageDays,
  impliedValue,
  isPreToken,
  isRankable,
  buildBoard,
  liveRows,
  radarRow,
  buildRadar,
  parseSnapshot,
  boardIssue,
  dataScript,
  farmSteps,
  stepText,
} from '../lib/model.ts';
import type { Snapshot, SnapshotProtocol } from '../lib/model.ts';

/** One protocol, with the fields a test cares about overridden. */
function makeProtocol(overrides: Partial<SnapshotProtocol> = {}): SnapshotProtocol {
  return {
    slug: 'proto',
    name: 'Protocol',
    category: 'DEX',
    chains: ['ethereum'],
    tvl_usd: 100_000_000,
    change_7d: 0,
    mcap_usd: null,
    listed_at: '2020-01-01',
    gecko_id: null,
    symbol: null,
    ...overrides,
  };
}

/** One snapshot document, with the fields a test cares about overridden. */
function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    as_of: '2026-11-14',
    source: 'test',
    floor_usd: 50_000_000,
    protocols: [],
    watchlist: [],
    ...overrides,
  };
}

test('ageDays counts whole days and clamps the future to zero', () => {
  assert.equal(ageDays('2026-11-14', '2026-11-14'), 0);
  assert.equal(ageDays('2026-11-14', '2026-11-04'), 10);
  assert.equal(ageDays('2024-03-01', '2024-02-28'), 2);
  assert.equal(ageDays('2026-11-14', null), null);
  assert.equal(ageDays('2026-11-14', 'not-a-date'), null);
  assert.equal(ageDays('2026-11-14', '2026-11-20'), 0);
});

test('ageDays counts a long-lived protocol in thousands of days', () => {
  const age = ageDays('2026-11-14', '2020-01-01');
  assert.ok(age !== null && age > 2000, `expected age over 2000 days, got ${age}`);
});

test('impliedValue: a billion TVL, no growth, old protocol is exactly a quarter of TVL', () => {
  const p = makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 0, listed_at: '2020-01-01' });
  const v = impliedValue(p, '2026-11-14', MODEL);
  assert.equal(v.implied, 250_000_000);
  assert.equal(v.growthPct, 0);
  assert.equal(v.growthMult, 1);
  assert.equal(v.maturityMult, 1);
  assert.equal(v.sizeMult, 1);
  assert.ok(v.age !== null && v.age > 1095);
});

test('impliedValue: growth of +10% adds nine percent, not ten', () => {
  const p = makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 10, listed_at: '2020-01-01' });
  const v = impliedValue(p, '2026-11-14', MODEL);
  assert.equal(v.growthPct, 10);
  assert.equal(v.growthMult, 1.09);
  assert.equal(v.implied, 272_500_000);
});

test('impliedValue: a fall of 10% costs fourteen percent, more than the rise gains', () => {
  const up = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 10, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  const down = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: -10, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.equal(down.growthMult, 0.86);
  assert.equal(down.implied, 215_000_000);
  assert.ok(up.implied + down.implied < 2 * 250_000_000, 'downside must weigh more than upside');
});

test('impliedValue: growth is clamped to +60% and to -50%', () => {
  const spike = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 100, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.equal(spike.growthPct, 60);
  assert.equal(spike.growthMult, 1.54);
  assert.equal(spike.implied, 385_000_000);
  const crash = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: -80, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.equal(crash.growthPct, -50);
  assert.ok(Math.abs(crash.growthMult - 0.3) < 1e-9, `expected growthMult 0.3, got ${crash.growthMult}`);
  assert.equal(crash.implied, 75_000_000);
});

test('impliedValue: a missing seven-day change counts as no change', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: null, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.equal(v.growthPct, 0);
  assert.equal(v.implied, 250_000_000);
});

test('impliedValue: a 30-day-old protocol is discounted to 55% by maturity', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 0, listed_at: '2026-10-15' }), '2026-11-14', MODEL);
  assert.equal(v.age, 30);
  assert.equal(v.maturityMult, 0.55);
  assert.equal(v.implied, 137_500_000);
});

test('impliedValue: an unknown age is scored at the ramp midpoint, 85%', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 1_000_000_000, change_7d: 0, listed_at: null }), '2026-11-14', MODEL);
  assert.equal(v.age, null);
  assert.equal(v.maturityMult, 0.85);
  assert.equal(v.implied, 212_500_000);
});

test('impliedValue: a huge protocol is clamped to the 0.8 size floor', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 20_000_000_000, change_7d: 0, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.equal(v.sizeMult, 0.8);
  assert.equal(v.implied, 4_000_000_000);
});

test('impliedValue: a small protocol carries option value, between 19.5M and 19.7M', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 50_000_000, change_7d: 0, listed_at: '2020-01-01' }), '2026-11-14', MODEL);
  assert.ok(v.implied > 19_500_000 && v.implied < 19_700_000, `got ${v.implied}`);
  assert.ok(v.sizeMult > 1.5 && v.sizeMult < 1.6);
});

test('impliedValue: the implied value never falls below one dollar', () => {
  const v = impliedValue(makeProtocol({ tvl_usd: 1, change_7d: -50, listed_at: '2026-10-15' }), '2026-11-14', MODEL);
  assert.equal(v.implied, 1);
});

test('impliedValue: the reported age matches ageDays', () => {
  const p = makeProtocol({ listed_at: '2023-06-01' });
  const v = impliedValue(p, '2026-11-14', MODEL);
  assert.equal(v.age, ageDays('2026-11-14', '2023-06-01'));
});

test('isPreToken: no market cap, no CoinGecko id and no symbol means pre-token', () => {
  assert.equal(isPreToken(makeProtocol()), true);
  assert.equal(isPreToken(makeProtocol({ mcap_usd: 1 })), false);
  assert.equal(isPreToken(makeProtocol({ gecko_id: 'foo' })), false);
  assert.equal(isPreToken(makeProtocol({ symbol: 'FOO' })), false);
});

test('isRankable: exchanges and versioned pools are kept off the board', () => {
  assert.equal(isRankable(makeProtocol({ category: 'DEX' })), true);
  assert.equal(isRankable(makeProtocol({ category: 'CEX' })), false);
  assert.equal(isRankable(makeProtocol({ name: 'Foo V2' })), false);
  assert.equal(isRankable(makeProtocol({ name: 'Foo v2.1' })), false);
  assert.equal(isRankable(makeProtocol({ name: 'Foo 2.0' })), false);
  assert.equal(isRankable(makeProtocol({ name: 'Foo 2' })), true);
  assert.equal(isRankable(makeProtocol({ mcap_usd: 5_000_000 })), false);
});

test('farmSteps: six steps, each with an action, a cost and a time', () => {
  const steps = farmSteps(makeProtocol(), 400);
  assert.equal(steps.length, 6);
  for (const s of steps) {
    assert.ok(s.text.length > 0);
    assert.ok(s.cost.length > 0);
    assert.ok(s.time.length > 0);
  }
  assert.match(steps[0]!.text, /fresh wallet/);
  assert.match(steps[5]!.text, /farm log/);
});

test('farmSteps: the first step is always the fresh wallet, whatever the category', () => {
  for (const category of ['Lending', 'DEX', 'Bridge', 'RWA', null]) {
    const steps = farmSteps(makeProtocol({ category }), 400);
    assert.match(steps[0]!.text, /fresh wallet/, `category ${category}`);
  }
});

test('farmSteps: the action follows the category', () => {
  const cases: Array<[string | null, RegExp]> = [
    ['Lending', /Supply \$150 of USDC/],
    ['CDP', /Supply \$150 of USDC/],
    ['DEX', /Provide \$150 of liquidity/],
    ['Yield', /Provide \$150 of liquidity/],
    ['Bridge', /Bridge \$150 of USDC/],
    ['Staking', /Stake \$150/],
    ['Restaking', /Stake \$150/],
    ['Perpetual', /Deposit \$150 of USDC as margin/],
    ['Prediction', /Fund \$150/],
    ['Curator', /Deposit \$150 into a .* vault/],
    ['Stablecoins', /Mint or deposit \$150/],
    ['RWA', /Mint \$150 of the protocol's yield asset/],
    ['Insurance', /Buy \$150 of cover/],
    ['Something Else', /Deposit \$150 of USDC into/],
    [null, /Deposit \$150 of USDC into/],
  ];
  for (const [category, pattern] of cases) {
    const steps = farmSteps(makeProtocol({ category, tvl_usd: 1_000_000_000 }), 400);
    assert.match(steps[1]!.text, pattern, `category ${category}`);
  }
});

test('farmSteps: capital follows TVL in four tiers', () => {
  const capital = (tvl: number) => farmSteps(makeProtocol({ tvl_usd: tvl, category: 'DEX' }), 400)[1]!.text;
  assert.match(capital(5_000_000_000), /\$250/);
  assert.match(capital(4_999_999_999), /\$150/);
  assert.match(capital(1_000_000_000), /\$150/);
  assert.match(capital(999_999_999), /\$100/);
  assert.match(capital(100_000_000), /\$100/);
  assert.match(capital(99_999_999), /\$50/);
});

test('farmSteps: gas is dear on Ethereum, cheap on L2s and fast L1s', () => {
  const cost0 = (chain: string) => farmSteps(makeProtocol({ chains: [chain] }), 400)[0]!.cost;
  assert.match(cost0('Ethereum'), /about \$6 to \$15 of gas/);
  assert.match(cost0('Arbitrum'), /under \$0\.50 of gas/);
  assert.match(cost0('Base'), /under \$0\.50 of gas/);
  assert.match(cost0('Solana'), /under \$1 of gas/);
  assert.match(cost0('Polygon'), /under \$1 of gas/);
  assert.match(cost0('Frobchain'), /a few dollars of gas/);
});

test('farmSteps: the hold is longer for younger protocols', () => {
  const hold = (age: number | null) => farmSteps(makeProtocol(), age)[3]!.text;
  assert.match(hold(null), /at least 30 days/);
  assert.match(hold(100), /at least 60 days/);
  assert.match(hold(179), /at least 60 days/);
  assert.match(hold(180), /at least 45 days/);
  assert.match(hold(364), /at least 45 days/);
  assert.match(hold(365), /at least 30 days/);
});

test('farmSteps: the weekly action follows the category too', () => {
  const weekly = (category: string | null) => farmSteps(makeProtocol({ category }), 400)[2]!.text;
  assert.match(weekly('Lending'), /Borrow a small amount against the supply/);
  assert.match(weekly('DEX'), /highest-fee range/);
  assert.match(weekly('Bridge'), /bridge a small amount back/);
  assert.match(weekly('Staking'), /Restake the receipt/);
  assert.match(weekly('RWA'), /Claim the yield distribution/);
  assert.match(weekly('Insurance'), /renew the cover/);
  assert.match(weekly('Unknown'), /qualifying action/);
});

test('stepText: a step reads as one line with its cost and time', () => {
  const s = stepText({ text: 'Do the thing.', cost: '$5', time: '5 minutes' });
  assert.equal(s, 'Do the thing. Cost: $5. Time: 5 minutes.');
  assert.ok(s.length >= 20 && s.length <= 600);
});

test('stepText: a too-short step is padded, a too-long step is cut to 599 characters', () => {
  const short = stepText({ text: '', cost: '', time: '' });
  assert.ok(short.length >= 20);
  assert.match(short, /Hold the position and check the protocol's own page/);
  const long = stepText({ text: 'x'.repeat(700), cost: 'c', time: 't' });
  assert.equal(long.length, 599);
  assert.ok(long.endsWith('...'));
});

test('buildBoard: the watchlist is the floor and the early radar adds below it', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha', 'beta'],
    protocols: [
      makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }),
      makeProtocol({ slug: 'beta', name: 'Beta', tvl_usd: 100_000_000 }),
      makeProtocol({ slug: 'gamma', name: 'Gamma', tvl_usd: 40_000_000 }),
      makeProtocol({ slug: 'delta', name: 'Delta', tvl_usd: 900_000_000, mcap_usd: 1_000_000_000, gecko_id: 'delta', symbol: 'DELTA' }),
      makeProtocol({ slug: 'epsilon', name: 'Epsilon', category: 'CEX', tvl_usd: 800_000_000 }),
      makeProtocol({ slug: 'zeta', name: 'Zeta V2', tvl_usd: 700_000_000 }),
      makeProtocol({ slug: 'eta', name: 'Eta', tvl_usd: 60_000_000 }),
    ],
  });
  const board = buildBoard(snap);
  assert.deepEqual(board.map((r) => r.slug), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(board.map((r) => r.rank), [1, 2, 3]);
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i]!.implied_value_usd <= board[i - 1]!.implied_value_usd, 'implied value must not rise with rank');
  }
  assert.equal(board[0]!.token_status, 'pre-token');
  assert.equal(boardIssue(board, snap), null);
});

test('buildBoard: a protocol above the floor but off the watchlist is not added', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha'],
    protocols: [
      makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }),
      makeProtocol({ slug: 'eta', name: 'Eta', tvl_usd: 60_000_000 }),
    ],
  });
  const board = buildBoard(snap);
  assert.deepEqual(board.map((r) => r.slug), ['alpha']);
});

test('buildBoard: the early radar is capped at 160 rows', () => {
  const early = Array.from({ length: 200 }, (_, i) =>
    makeProtocol({ slug: `early-${i}`, name: `Early ${i}`, tvl_usd: 40_000_000 - i * 1000 }),
  );
  const snap = makeSnapshot({ watchlist: ['alpha'], protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }), ...early] });
  const board = buildBoard(snap);
  assert.equal(board.length, 161);
  assert.equal(board.filter((r) => r.slug.startsWith('early-')).length, 160);
});

test('buildBoard: a missing watchlist slug is reported by the gate, not hidden', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha', 'ghost'],
    protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 })],
  });
  const board = buildBoard(snap);
  assert.deepEqual(board.map((r) => r.slug), ['alpha']);
  const issue = boardIssue(board, snap);
  assert.ok(issue !== null && issue.includes('ghost'), `expected the gate to name ghost, got ${issue}`);
});

test('buildBoard: equal implied values break ties by slug', () => {
  const snap = makeSnapshot({
    watchlist: ['b-proto', 'a-proto'],
    protocols: [
      makeProtocol({ slug: 'b-proto', name: 'B', tvl_usd: 100_000_000 }),
      makeProtocol({ slug: 'a-proto', name: 'A', tvl_usd: 100_000_000 }),
    ],
  });
  const board = buildBoard(snap);
  assert.equal(board[0]!.implied_value_usd, board[1]!.implied_value_usd);
  assert.deepEqual(board.map((r) => r.slug), ['a-proto', 'b-proto']);
});

test('buildBoard: every row carries its model inputs and six farm steps', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha'],
    protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 })],
  });
  const row = buildBoard(snap)[0]!;
  assert.equal(row.model.base_multiple, 0.25);
  assert.equal(typeof row.model.growth_multiplier, 'number');
  assert.equal(typeof row.model.maturity_multiplier, 'number');
  assert.equal(typeof row.model.size_multiplier, 'number');
  assert.equal(row.farm_steps.length, 6);
  for (const s of row.farm_steps) assert.ok(s.length >= 20 && s.length <= 600, `farm step of ${s.length} chars`);
});

test('liveRows: the live view is the top 24 by market cap, exchanges excluded', () => {
  const live = Array.from({ length: 30 }, (_, i) =>
    makeProtocol({ slug: `live-${i}`, name: `Live ${i}`, mcap_usd: (30 - i) * 1_000_000, gecko_id: `live-${i}`, symbol: `L${i}`, tvl_usd: 10_000_000 }),
  );
  const snap = makeSnapshot({
    protocols: [...live, makeProtocol({ slug: 'big-cex', name: 'Big CEX', category: 'CEX', mcap_usd: 999_000_000, gecko_id: 'big-cex', symbol: 'BC' })],
  });
  const rows = liveRows(snap);
  assert.equal(rows.length, 24);
  assert.equal(rows[0]!.mcap_usd, 30_000_000);
  assert.equal(rows[23]!.mcap_usd, 7_000_000);
  assert.ok(!rows.some((r) => r.slug === 'big-cex'));
  for (let i = 1; i < rows.length; i++) assert.ok((rows[i]!.mcap_usd ?? 0) <= (rows[i - 1]!.mcap_usd ?? 0));
});

test('radarRow: the compact row keeps the rank, the value and the multipliers', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha'],
    protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 })],
  });
  const compact = radarRow(buildBoard(snap)[0]!);
  assert.equal(compact.slug, 'alpha');
  assert.equal(compact.rank, 1);
  assert.ok(compact.implied_value_usd > 0);
  assert.equal(typeof compact.growth_multiplier, 'number');
  assert.equal(compact.farm_steps, undefined);
});

test('parseSnapshot: a valid document parses, with missing optionals as null', () => {
  const snap = parseSnapshot(JSON.stringify({
    as_of: '2026-11-14',
    source: 'test',
    floor_usd: 50_000_000,
    protocols: [{ slug: 'a', name: 'A', tvl_usd: 100 }],
    watchlist: ['a'],
  }));
  assert.equal(snap.as_of, '2026-11-14');
  assert.equal(snap.protocols[0]!.category, null);
  assert.deepEqual(snap.protocols[0]!.chains, []);
  assert.equal(snap.protocols[0]!.change_7d, null);
  assert.equal(snap.watchlist[0], 'a');
});

test('parseSnapshot: a full protocol round-trips every field', () => {
  const snap = parseSnapshot(JSON.stringify({
    as_of: '2026-11-14',
    source: 'test',
    floor_usd: 50_000_000,
    protocols: [{
      slug: 'a', name: 'A', category: 'DEX', chains: ['ethereum', 'arbitrum'],
      tvl_usd: 123, change_7d: 4.5, mcap_usd: 999, listed_at: '2021-05-01',
      gecko_id: 'a', symbol: 'A',
    }],
    watchlist: [],
  }));
  const p = snap.protocols[0]!;
  assert.equal(p.category, 'DEX');
  assert.deepEqual(p.chains, ['ethereum', 'arbitrum']);
  assert.equal(p.change_7d, 4.5);
  assert.equal(p.mcap_usd, 999);
  assert.equal(p.listed_at, '2021-05-01');
});

test('parseSnapshot: malformed input is refused with SnapshotError', () => {
  assert.throws(() => parseSnapshot('not json'), SnapshotError);
  assert.throws(() => parseSnapshot('[]'), SnapshotError);
  assert.throws(() => parseSnapshot('null'), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ source: 'x', floor_usd: 1, protocols: [], watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026/11/14', source: 'x', floor_usd: 1, protocols: [], watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 0, protocols: [], watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 1.5, protocols: [], watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 1, protocols: {}, watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 1, protocols: [], watchlist: [1] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 1, protocols: [{ slug: 'a', name: 'A' }], watchlist: [] })), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 'x', floor_usd: 1, protocols: [{ slug: 'a', name: 'A', tvl_usd: Number.NaN }], watchlist: [] })), SnapshotError);
});

test('boardIssue: a valid board passes every gate at once', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha', 'beta'],
    protocols: [
      makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }),
      makeProtocol({ slug: 'beta', name: 'Beta', tvl_usd: 100_000_000 }),
    ],
  });
  assert.equal(boardIssue(buildBoard(snap), snap), null);
});

test('boardIssue: each failure names the fault', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha', 'beta'],
    protocols: [
      makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }),
      makeProtocol({ slug: 'beta', name: 'Beta', tvl_usd: 100_000_000 }),
    ],
  });
  const brokenRanks = buildBoard(snap);
  brokenRanks[0]!.rank = 2;
  assert.match(boardIssue(brokenRanks, snap)!, /rank 1 is 2/);
  const outOfOrder = buildBoard(snap);
  outOfOrder[0]!.implied_value_usd = outOfOrder[1]!.implied_value_usd - 1;
  assert.match(boardIssue(outOfOrder, snap)!, /outranks/);
  const allSame = buildBoard(snap);
  for (const r of allSame) r.implied_value_usd = 100;
  assert.match(boardIssue(allSame, snap)!, /share the same implied value/);
  const fewSteps = buildBoard(snap);
  fewSteps[0]!.farm_steps = ['one', 'two'];
  assert.match(boardIssue(fewSteps, snap)!, /2 farm steps/);
  const shortStep = buildBoard(snap);
  shortStep[0]!.farm_steps = ['tiny', 'a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(30)];
  assert.match(boardIssue(shortStep, snap)!, /farm step of 4 characters/);
  const zeroValue = buildBoard(snap);
  zeroValue[zeroValue.length - 1]!.implied_value_usd = 0;
  assert.match(boardIssue(zeroValue, snap)!, /implied value 0/);
});

test('buildRadar: the dashboard payload carries the board, the live set and the model', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha', 'beta'],
    protocols: [
      makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 }),
      makeProtocol({ slug: 'beta', name: 'Beta', tvl_usd: 100_000_000 }),
      makeProtocol({ slug: 'gamma', name: 'Gamma', tvl_usd: 40_000_000 }),
      makeProtocol({ slug: 'delta', name: 'Delta', tvl_usd: 900_000_000, mcap_usd: 1_000_000_000, gecko_id: 'delta', symbol: 'DELTA' }),
    ],
  });
  const { board, radar } = buildRadar(snap);
  assert.equal(board.length, 3);
  assert.equal(radar.board_size, 3);
  assert.equal(radar.watchlist_size, 2);
  assert.equal(radar.early_size, 1);
  assert.equal(radar.live_size, 1);
  assert.equal(radar.model_version, 'radar-2');
  assert.equal(radar.as_of, '2026-11-14');
  assert.equal(radar.floor_usd, 50_000_000);
  assert.equal(radar.rows.length, 3);
  assert.equal(radar.live[0]!.slug, 'delta');
  assert.deepEqual(radar.model, MODEL);
});

test('buildRadar: a board with no early rows reports early_size zero', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha'],
    protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 })],
  });
  const { radar } = buildRadar(snap);
  assert.equal(radar.early_size, 0);
  assert.equal(radar.live_size, 0);
});

test('dataScript: the dataset is one script that assigns window.RADAR and parses back', () => {
  const snap = makeSnapshot({
    watchlist: ['alpha'],
    protocols: [makeProtocol({ slug: 'alpha', name: 'Alpha', tvl_usd: 500_000_000 })],
  });
  const { radar } = buildRadar(snap);
  const script = dataScript(radar);
  assert.ok(script.startsWith('window.RADAR='));
  assert.ok(script.endsWith(';\n'));
  const payload = script.slice('window.RADAR='.length, -2);
  const parsed = JSON.parse(payload) as { model_version: string; rows: unknown[] };
  assert.equal(parsed.model_version, 'radar-2');
  assert.equal(parsed.rows.length, 1);
});

test('MODEL: the radar-2 constants are the ones the dashboard states', () => {
  assert.equal(MODEL_VERSION, 'radar-2');
  assert.equal(EARLY_ROWS, 160);
  assert.equal(LIVE_ROWS, 24);
  assert.equal(MODEL.base_multiple, 0.25);
  assert.equal(MODEL.growth_up_weight, 0.9);
  assert.equal(MODEL.growth_down_weight, 1.4);
  assert.equal(MODEL.growth_floor, -50);
  assert.equal(MODEL.growth_cap, 60);
  assert.equal(MODEL.size_exponent, -0.15);
  assert.equal(MODEL.size_ref_usd, 1_000_000_000);
  assert.equal(MODEL.maturity_young_days, 90);
  assert.equal(MODEL.maturity_young, 0.55);
  assert.equal(MODEL.maturity_mid, 0.85);
  assert.equal(MODEL.maturity_full, 1.0);
  assert.equal(MODEL.maturity_days, 1095);
  assert.equal(MODEL.unknown_age_days, 365);
});

test('MODEL: the downside weight is heavier than the upside weight, by design', () => {
  assert.ok(MODEL.growth_down_weight > MODEL.growth_up_weight);
  assert.ok(MODEL.growth_cap < 100, 'a single week never counts in full');
  assert.ok(Math.abs(MODEL.growth_floor) < MODEL.growth_cap, 'the floor is tighter than the cap');
});
