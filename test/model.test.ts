// radar-3 model tests: the fitted curve, the tilts, the universe rules, the farm economics,
// the board, the validation and the gate. Run with: node --test test/model.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MODEL_VERSION,
  ageDays,
  bandAndRankRange,
  cheapestChain,
  curveValue,
  farmEcon,
  farmSteps,
  fitCurve,
  fitPoints,
  flipFeeTarget,
  flipValueTarget,
  fundingAssetFor,
  gasUsd,
  gridNet,
  growthMult,
  holdDaysFor,
  impliedValue,
  isPreToken,
  isRankable,
  maturityMult,
  ols,
  planFor,
  planMinutes,
  setAsideReason,
  stepText,
  stopRuleFor,
  tradedStems,
} from '../dashboard/model.js';
import { boardIssue, buildBoard, buildRadar, dataScript, liveRows, parseSnapshot, radarRow } from '../lib/board.ts';
import { bootstrapRefits, looCheck, rankCorr, timeSplitCheck } from '../lib/validate.ts';
import { checkDetailDom, checkDetailRow, costOfStepText } from '../tools/shot-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const realSnapshotPath = join(here, '..', '..', 'token-radar-01-kit', 'input', 'snapshot.json');

function approx(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);
}

/** One protocol record, with the fields the model reads. */
function protocol(overrides = {}) {
  return {
    slug: 'test-protocol',
    name: 'Test Protocol',
    category: 'Lending',
    chains: ['arbitrum'],
    tvl_usd: 100_000_000,
    change_7d: 0,
    mcap_usd: null,
    listed_at: '2024-01-01',
    gecko_id: null,
    symbol: null,
    ...overrides,
  };
}

/** A snapshot document from protocol records. */
function snapshot(protocols, watchlist = []) {
  return { as_of: '2026-11-14', source: 'test', floor_usd: 50_000_000, protocols, watchlist };
}

/** Traded comps lying exactly on log10(mcap) = 7.2 + 0.52 x log10(TVL / $100M). */
function curveComps(count = 12) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const tvl = 10_000_000 * Math.pow(10, i / 4);
    const mcap = Math.pow(10, 7.2 + 0.52 * Math.log10(tvl / 1e8));
    out.push(
      protocol({
        slug: `comp-${i}`,
        name: `Comp ${i}`,
        category: 'Lending',
        tvl_usd: Math.round(tvl),
        mcap_usd: Math.round(mcap),
        gecko_id: `comp-${i}`,
        symbol: `C${i}`,
        listed_at: i < 8 ? '2022-06-01' : '2025-03-01',
      }),
    );
  }
  return out;
}

describe('ageDays', () => {
  test('counts whole days between listing and the snapshot date', () => {
    assert.equal(ageDays('2026-11-14', '2025-11-14'), 365);
    assert.equal(ageDays('2026-11-14', '2026-11-14'), 0);
  });
  test('null or bad listing dates give null, a future listing gives zero', () => {
    assert.equal(ageDays('2026-11-14', null), null);
    assert.equal(ageDays('2026-11-14', 'not-a-date'), null);
    assert.equal(ageDays('2026-11-14', '2027-01-01'), 0);
  });
});

describe('ols', () => {
  test('recovers an exact line with R squared 1', () => {
    const pts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((x) => ({ x, y: 2 * x + 1 }));
    const fit = ols(pts);
    approx(fit.a, 1);
    approx(fit.b, 2);
    approx(fit.r2, 1);
    assert.equal(fit.n, 12);
  });
  test('refuses too few points and a degenerate x', () => {
    assert.equal(ols([{ x: 1, y: 2 }]), null);
    assert.equal(
      ols(Array.from({ length: 12 }, () => ({ x: 1, y: 2 }))),
      null,
    );
  });
});

describe('the fitted curve', () => {
  const snap = snapshot(curveComps());
  test('fitCurve recovers the curve the comps were built on', () => {
    const fit = fitCurve(snap);
    approx(fit.a, 7.2, 0.01);
    approx(fit.b, 0.52, 0.01);
    assert.equal(fit.n, 12);
    approx(fit.r2, 1, 0.001);
  });
  test('fitPoints trims a comp whose multiple is outside [1/500, 50]', () => {
    const pts = fitPoints(snap);
    assert.equal(pts.length, 12);
    const wild = protocol({ slug: 'wild', mcap_usd: 1, tvl_usd: 100_000_000, gecko_id: 'wild', symbol: 'W' });
    assert.equal(fitPoints(snapshot([...curveComps(), wild])).length, 12);
  });
  test('curveValue is 10^a at $100M of TVL and scales with the slope', () => {
    const fit = fitCurve(snap);
    approx(curveValue(1e8, fit), Math.pow(10, 7.2), 1);
    approx(curveValue(1e10, fit) / curveValue(1e8, fit), Math.pow(100, 0.52), 0.01);
  });
  test('CEX, bridges and versioned listings never enter the fit', () => {
    const extra = [
      protocol({ slug: 'cex-1', category: 'CEX', mcap_usd: 1e9, gecko_id: 'cex-1', symbol: 'CEX' }),
      protocol({ slug: 'br-1', category: 'Cross Chain Bridge', mcap_usd: 1e9, gecko_id: 'br-1', symbol: 'BR' }),
      protocol({ slug: 'v-1', name: 'Test V2', mcap_usd: 1e9, gecko_id: 'v-1', symbol: 'V' }),
    ];
    assert.equal(fitPoints(snapshot([...curveComps(), ...extra])).length, 12);
  });
});

describe('the tilts', () => {
  test('growthMult is 1 at zero, half the move, clamped to [0.7, 1.3]', () => {
    assert.equal(growthMult(0), 1);
    approx(growthMult(10), 1.05);
    approx(growthMult(-10), 0.95);
    assert.equal(growthMult(60), 1.3);
    assert.equal(growthMult(100), 1.3);
    assert.equal(growthMult(-50), 0.75);
    // The growth floor is -50%, so the lowest tilt the formula can reach is 0.75;
    // the 0.7 clamp floor never binds.
    assert.equal(growthMult(-100), 0.75);
    assert.equal(growthMult(null), 1);
  });
  test('maturityMult is the S-ramp: 0.55 young, 0.85 at a year, 1.0 past three years', () => {
    assert.equal(maturityMult(0), 0.55);
    assert.equal(maturityMult(89), 0.55);
    assert.equal(maturityMult(365), 0.85);
    assert.equal(maturityMult(1095), 1.0);
    assert.equal(maturityMult(2000), 1.0);
    assert.equal(maturityMult(null), 0.85);
  });
  test('impliedValue is the curve times the tilts, with a $1 floor', () => {
    const snap = snapshot(curveComps());
    const fit = fitCurve(snap);
    const p = protocol({ tvl_usd: 1e8, change_7d: 0, listed_at: '2020-01-01' });
    const v = impliedValue(p, snap.as_of, fit);
    assert.equal(v.implied, Math.round(Math.pow(10, 7.2)));
    assert.equal(v.growthMult, 1);
    assert.equal(v.maturityMult, 1);
    const up = impliedValue(protocol({ tvl_usd: 1e8, change_7d: 10, listed_at: '2020-01-01' }), snap.as_of, fit);
    const down = impliedValue(protocol({ tvl_usd: 1e8, change_7d: -10, listed_at: '2020-01-01' }), snap.as_of, fit);
    assert.ok(up.implied > v.implied && down.implied < v.implied);
    const tiny = impliedValue(protocol({ tvl_usd: 1, change_7d: -50, listed_at: '2026-11-01' }), snap.as_of, fit);
    assert.ok(tiny.implied >= 1);
  });
});

describe('the universe rules', () => {
  test('isPreToken needs all three token fields absent', () => {
    assert.equal(isPreToken(protocol()), true);
    assert.equal(isPreToken(protocol({ mcap_usd: 1 })), false);
    assert.equal(isPreToken(protocol({ gecko_id: 'x' })), false);
    assert.equal(isPreToken(protocol({ symbol: 'X' })), false);
  });
  test('setAsideReason names each exclusion', () => {
    const stems = new Set(['zebra']);
    assert.equal(setAsideReason(protocol({ category: 'CEX' }), stems), 'exchange');
    assert.equal(setAsideReason(protocol({ category: 'Canonical Bridge' }), stems), 'bridge');
    assert.equal(setAsideReason(protocol({ name: 'Test V2' }), stems), 'versioned listing');
    assert.equal(setAsideReason(protocol({ name: 'Wrapped Ether' }), stems), 'wrapped or staked product');
    assert.equal(setAsideReason(protocol({ name: 'Zebra Lend' }), stems), 'name shared with a traded token');
    assert.equal(setAsideReason(protocol({ name: 'Yield Farm' }), new Set(['yield'])), null);
    assert.equal(setAsideReason(protocol(), stems), null);
  });
  test('tradedStems takes distinctive first words only', () => {
    const snap = snapshot([
      protocol({ slug: 'a', name: 'Zebra Finance', mcap_usd: 1e8, gecko_id: 'a', symbol: 'A' }),
      protocol({ slug: 'b', name: 'Yield Max', mcap_usd: 1e8, gecko_id: 'b', symbol: 'B' }),
    ]);
    const stems = tradedStems(snap);
    assert.ok(stems.has('zebra'));
    assert.ok(!stems.has('yield'));
  });
  test('isRankable exempts the watchlist and excludes the rest with a reason', () => {
    const wl = new Set(['watch-cex']);
    const stems = new Set();
    assert.equal(isRankable(protocol({ slug: 'watch-cex', category: 'CEX' }), wl, stems), true);
    assert.equal(isRankable(protocol({ slug: 'plain-cex', category: 'CEX' }), wl, stems), false);
    assert.equal(isRankable(protocol({ slug: 'clean' }), wl, stems), true);
    assert.equal(isRankable(protocol({ slug: 'traded', mcap_usd: 1e8, gecko_id: 't', symbol: 'T' }), wl, stems), false);
  });
});

describe('the farm economics', () => {
  test('gas tiers: Ethereum is dear, L2s and fast L1s are cheap', () => {
    assert.equal(gasUsd('ethereum'), 10);
    assert.equal(gasUsd('arbitrum'), 0.25);
    assert.equal(gasUsd('solana'), 0.5);
    assert.equal(gasUsd('some-new-chain'), 2);
  });
  test('cheapestChain picks the cheapest of the first three chains', () => {
    assert.deepEqual(cheapestChain(protocol({ chains: ['ethereum', 'arbitrum', 'solana'] })), { chain: 'arbitrum', gasUsd: 0.25 });
    assert.deepEqual(cheapestChain(protocol({ chains: [] })), { chain: 'its main chain', gasUsd: 2 });
  });
  test('holdDaysFor gives younger protocols a longer window', () => {
    assert.equal(holdDaysFor(null), 30);
    assert.equal(holdDaysFor(100), 60);
    assert.equal(holdDaysFor(300), 45);
    assert.equal(holdDaysFor(500), 30);
  });
  test('farmEcon nets the slice against fees and the T-bill cost', () => {
    // TVL $100M, implied $10M, 30-day hold on Arbitrum: deposit $5,000 (a dollar pays).
    const e = farmEcon(protocol({ chains: ['arbitrum'] }), 10_000_000, 400);
    assert.equal(e.deposit, 5000);
    approx(e.slice, 50);
    approx(e.fees, 1);
    approx(e.capitalCost, 16.44, 0.01);
    approx(e.net, 32.56, 0.01);
    approx(e.breakEvenOdds, 0.3488, 0.001);
    // Break-even odds 34.9% are above the 25% THIN line, so this row is a SKIP.
    assert.equal(e.verdict, 'SKIP');
    assert.ok(e.minDeposit > 0 && e.minDeposit < e.deposit);
  });
  test('farmEcon deposits the floor and skips when a dollar does not pay', () => {
    // A giant: implied/TVL so low the T-bill cost eats the slice.
    const e = farmEcon(protocol({ tvl_usd: 5_000_000_000, chains: ['ethereum'] }), 60_000_000, 400);
    assert.equal(e.deposit, 500);
    assert.equal(e.verdict, 'SKIP');
    assert.equal(e.minDeposit, null);
  });
  test('farmEcon farms a small cheap-chain protocol with a high multiple', () => {
    const e = farmEcon(protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] }), 50_000_000, 400);
    assert.equal(e.verdict, 'FARM');
    assert.ok(e.net > 0 && e.perHour > 0);
  });
  test('planMinutes allocates the model time budget: 30 setup + 15 min/week + 30 exit', () => {
    approx(planMinutes(30), 124.29, 0.01);
    approx(planMinutes(45), 156.43, 0.01);
    approx(planMinutes(60), 188.57, 0.01);
  });
  test('step minutes sum to planMinutes and match activeHours within 2 minutes (hours-consistency)', () => {
    const check = (p, implied, age) => {
      const e = farmEcon(p, implied, age);
      const plan = planFor(p, e, age, implied);
      const sum = plan.reduce((a, s) => a + (s.mins || 0), 0);
      approx(sum, planMinutes(e.holdDays), 0.01);
      assert.ok(Math.abs(sum - e.activeHours * 60) <= 2, `step sum ${sum} vs hours ${e.activeHours * 60}`);
      for (const s of plan) assert.ok(typeof s.mins === 'number' && s.mins > 0, s.time);
      assert.ok(!plan.some((s) => /a day/.test(s.time)), 'no rate-style step times');
    };
    const farmP = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    check(farmP, 50_000_000, 400);
    const thinP = protocol({ tvl_usd: 50_000_000, chains: ['arbitrum'] });
    check(thinP, 10_000_000, 400);
    const skipP = protocol({ chains: ['arbitrum'] });
    check(skipP, 10_000_000, 400);
    const farm = planFor(farmP, farmEcon(farmP, 50_000_000, 400), 400, 50_000_000);
    assert.equal(farm.find((s) => s.action.startsWith('Verify:')).time, '5 minutes');
    assert.equal(farm.find((s) => s.action.startsWith('Claim')).time, '5 minutes');
    assert.ok(farm.find((s) => s.time.includes('×')).time.startsWith('15 minutes ×'));
  });
  test('farmEcon activeHours and perHour follow the B-prime formula (0.5h + 0.25h/week + 0.5h)', () => {
    const p = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    const e = farmEcon(p, 50_000_000, 400);
    assert.equal(e.verdict, 'FARM');
    assert.equal(e.holdDays, 30);
    assert.equal(e.activeHours, 2.07);
    approx(e.perHour, e.net / (0.5 + (30 / 7) * 0.25 + 0.5), 0.02);
    assert.ok(e.perHour > 900);
  });
  test('fundingAssetFor names the funding asset by category and chain (E3)', () => {
    const btc = protocol({ category: 'BTC', chains: ['bitcoin'] });
    assert.deepEqual(fundingAssetFor(btc, 'Bitcoin'), { asset: 'BTC', bridge: 0 });
    const btcOff = protocol({ category: 'BTC', chains: ['ethereum'] });
    assert.equal(fundingAssetFor(btcOff, 'Ethereum').asset, 'BTC');
    assert.ok(fundingAssetFor(btcOff, 'Ethereum').bridge > 0);
    const stak = protocol({ category: 'Liquid Staking', chains: ['solana'] });
    assert.equal(fundingAssetFor(stak, 'Solana').asset, 'SOL');
    assert.equal(fundingAssetFor(stak, 'Solana').bridge, 0);
    const stakUnknown = protocol({ category: 'Liquid Staking', chains: ['fraxtal'] });
    assert.equal(fundingAssetFor(stakUnknown, 'Fraxtal').asset, null);
    const dex = protocol({ category: 'Dexs', chains: ['solana'] });
    assert.deepEqual(fundingAssetFor(dex, 'Solana'), { asset: 'USDC', bridge: 0 });
    // The deposit step names the native coin on staking rows, and the bridge fee is 0 on-board.
    const e = farmEcon(stak, 50_000_000, 400);
    const plan = planFor(stak, e, 400, 50_000_000);
    assert.ok(plan.some((s) => s.action.includes('of SOL through')), plan.map((s) => s.action).join(' | '));
    assert.equal(e.fundingAsset, 'SOL');
  });
  test('gridNet derives net from econ: slice and capital scale with deposit, fees fixed', () => {
    const p = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    const e = farmEcon(p, 50_000_000, 400);
    assert.equal(gridNet(e, 5000, 0), e.net);
    assert.equal(gridNet(e, 5000, 0.2), Math.round((0.8 * e.slice - e.fees - e.capitalCost) * 100) / 100);
    assert.equal(gridNet(e, 1000, 0), Math.round((0.2 * e.slice - e.fees - 0.2 * e.capitalCost) * 100) / 100);
    assert.ok(gridNet(e, 10000, 0) > gridNet(e, 5000, 0));
  });
  test('stopRuleFor is twice the seven-day swing, clamped to 10-35%', () => {
    assert.deepEqual(stopRuleFor(protocol({ tvl_usd: 100_000_000, change_7d: 5 })), { pct: 10, level: 90_000_000 });
    assert.deepEqual(stopRuleFor(protocol({ tvl_usd: 100_000_000, change_7d: -20 })), { pct: 35, level: 65_000_000 });
    assert.deepEqual(stopRuleFor(protocol({ tvl_usd: 100_000_000, change_7d: null })), { pct: 20, level: 80_000_000 });
  });
  test('stepText renders a structured step and truncates a long one', () => {
    const s = stepText({ day: 1, action: 'Do it.', where: 'Test', amount: '$0', cost: '$1', time: '1 minute' });
    assert.ok(s.startsWith('Day 1 — Do it.'));
    assert.ok(s.includes('Cost: $1. Time: 1 minute.'));
    assert.ok(s.length >= 20);
    const long = stepText({ day: 1, action: 'x'.repeat(700), where: 'Test', amount: '$0', cost: '$1', time: '1 minute' });
    assert.ok(long.length <= 600 && long.endsWith('...'));
  });
  test('farmSteps are nine dated steps on FARM, verdict first, with Verify, Claim and a stop rule', () => {
    const p = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    const e = farmEcon(p, 50_000_000, 400);
    const steps = farmSteps(p, e, 400, 50_000_000);
    assert.equal(steps.length, 9);
    assert.ok(steps[0].includes('Verdict: FARM'));
    assert.ok(steps.some((s) => s.includes('Verify:')));
    assert.ok(steps.some((s) => s.includes('Claim (only if')));
    assert.ok(steps.some((s) => s.includes('Stop:')));
    for (const s of steps) assert.ok(s.length >= 20 && s.length <= 600, s);
  });
});

describe('the farm plans', () => {
  test('planFor returns seven structured steps with day, action, place, amount, cost and time', () => {
    const p = protocol({ chains: ['arbitrum'] });
    const e = farmEcon(p, 10_000_000, 400);
    const plan = planFor(p, e, 400, 10_000_000);
    assert.equal(plan.length, 7);
    for (const s of plan) {
      assert.ok(typeof s.day === 'number' && s.day >= 1);
      assert.ok(s.action.length > 0 && s.where.length > 0 && s.amount.length > 0);
      assert.ok(s.cost.length > 0 && s.time.length > 0);
    }
    assert.ok(plan[0].action.startsWith('Verdict: SKIP'));
    assert.deepEqual(plan.map((s) => s.day), [1, 1, 1, 1, 7, 30, 30]);
  });
  test('a FARM plan names the deposit, chain and protocol on day 1', () => {
    const p = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    const e = farmEcon(p, 50_000_000, 400);
    assert.equal(e.verdict, 'FARM');
    const plan = planFor(p, e, 400, 50_000_000);
    assert.ok(plan[3].action.includes('$5,000'));
    assert.ok(plan[3].where.includes('arbitrum'));
    assert.ok(plan[3].amount.startsWith('$5,000'));
    assert.equal(plan[3].day, 1);
    assert.ok(plan[5].action.includes('running 400 days with no token'));
  });
  test('a THIN plan is a probe: same numbers as econ, no extra capital', () => {
    const p = protocol({ tvl_usd: 50_000_000, chains: ['arbitrum'] });
    const e = farmEcon(p, 10_000_000, 400);
    assert.equal(e.verdict, 'THIN');
    approx(e.breakEvenOdds, 0.1744, 0.001);
    const plan = planFor(p, e, 400, 10_000_000);
    assert.ok(plan[0].action.includes('probe only'));
    assert.ok(plan[2].action.includes('Probe only'));
    assert.ok(plan[2].amount.startsWith('$5,000'));
    assert.ok(plan[4].action.includes('do not add capital'));
  });
  test('a SKIP plan carries no deposit step and states its flip conditions', () => {
    const p = protocol({ chains: ['arbitrum'] });
    const e = farmEcon(p, 10_000_000, 400);
    assert.equal(e.verdict, 'SKIP');
    const steps = farmSteps(p, e, 400, 10_000_000);
    assert.equal(steps.length, 7);
    for (const s of steps.slice(1)) assert.ok(!/(deposit|supply|stake|mint|provide|bridge|fund) \$\d/i.test(s), s);
    const plan = planFor(p, e, 400, 10_000_000);
    assert.ok(plan[2].action.includes('Flip:'));
    assert.ok(plan[2].action.includes('would need to reach $'));
    const target = flipValueTarget(p, e);
    assert.ok(target > 10_000_000);
    assert.ok(plan[2].amount.includes(target.toLocaleString('en-US')));
    // Fees $1.00, capital $16.44, slice $50: even free gas leaves 16.4% odds, above the 10% line.
    assert.ok(plan[3].action.includes('even free transactions'));
  });
  test('plan step costs sum to econ.fees (FARM/THIN) or $0.00 (SKIP)', () => {
    const sumCosts = (plan) => plan.reduce((sum, s) => {
      const m = /^\$([\d.]+)/.exec(s.cost);
      return sum + (m ? Number(m[1]) : 0);
    }, 0);
    const farmP = protocol({ tvl_usd: 12_000_000, chains: ['arbitrum'] });
    const farmE = farmEcon(farmP, 50_000_000, 400);
    assert.equal(sumCosts(planFor(farmP, farmE, 400, 50_000_000)), farmE.fees);
    const skipP = protocol({ chains: ['arbitrum'] });
    const skipE = farmEcon(skipP, 10_000_000, 400);
    assert.equal(sumCosts(planFor(skipP, skipE, 400, 10_000_000)), 0);
  });
  test('flip targets derive from econ: V* pays at 10% odds, F* is the fee ceiling', () => {
    const p = protocol({ chains: ['arbitrum'] });
    const e = farmEcon(p, 10_000_000, 400);
    const target = flipValueTarget(p, e);
    const sliceAt = (0.1 * target * e.deposit) / p.tvl_usd;
    approx((e.fees + e.capitalCost) / sliceAt, 0.1, 0.001);
    // Fees $1.00, capital $16.44, slice $50: 0.1 x 50 - 16.44 < 0, so even free gas does not pay.
    assert.equal(flipFeeTarget(p, e), null);
    // Dear chain, rich multiple: slice $250, capital $16.44, so fees would need to fall to $8.56.
    const dear = protocol({ tvl_usd: 10_000_000, chains: ['ethereum'] });
    const ed = farmEcon(dear, 5_000_000, 400);
    assert.equal(ed.verdict, 'THIN');
    approx(flipFeeTarget(dear, ed), 8.56, 0.01);
    assert.ok(flipFeeTarget(dear, ed) < ed.fees);
  });
  test('ten sampled rows share almost no plan text once the name is stripped', (t) => {
    if (!existsSync(realSnapshotPath)) {
      t.skip('kit snapshot not present');
      return;
    }
    const snap = parseSnapshot(readFileSync(realSnapshotPath, 'utf8'));
    const fit = fitCurve(snap);
    const { rows } = buildBoard(snap, fit);
    const sample = [0, 22, 44, 66, 88, 110, 132, 154, 176, 198].map((i) => rows[i]);
    const texts = sample.map((r) => farmSteps(r, r.econ, r.age_days, r.implied_value_usd).join('\n').split(r.name).join(''));
    let identical = 0;
    let pairs = 0;
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        pairs++;
        if (texts[i] === texts[j]) identical++;
      }
    }
    assert.ok(identical / pairs < 0.2, `${identical} of ${pairs} pairs identical`);
  });
});

describe('the board', () => {
  test('buildBoard covers the watchlist, ranks 1..n in implied order, and names the set-aside', () => {
    const watch = protocol({ slug: 'watch-1', tvl_usd: 60_000_000 });
    const clean = protocol({ slug: 'clean-1', tvl_usd: 40_000_000 });
    const cex = protocol({ slug: 'cex-1', category: 'CEX', tvl_usd: 30_000_000 });
    const traded = protocol({ slug: 'traded-1', tvl_usd: 200_000_000, mcap_usd: 1e8, gecko_id: 't', symbol: 'T' });
    const snap = snapshot([...curveComps(), watch, clean, cex, traded], ['watch-1']);
    const fit = fitCurve(snap);
    const { rows, setAside } = buildBoard(snap, fit);
    const slugs = rows.map((r) => r.slug);
    assert.ok(slugs.includes('watch-1'));
    assert.ok(slugs.includes('clean-1'));
    assert.ok(!slugs.includes('cex-1'));
    assert.ok(!slugs.includes('traded-1'));
    assert.deepEqual(
      setAside.map((s) => s.slug),
      ['cex-1'],
    );
    assert.equal(setAside[0].reason, 'exchange');
    rows.forEach((r, i) => assert.equal(r.rank, i + 1));
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].implied_value_usd <= rows[i - 1].implied_value_usd);
    for (const r of rows) {
      assert.ok(['FARM', 'THIN', 'SKIP'].includes(r.verdict));
      assert.equal(r.farm_steps.length, r.verdict === 'FARM' ? 9 : 7);
    }
  });
  test('buildBoard flags above-floor rows that are not on the watchlist', () => {
    const big = protocol({ slug: 'big-1', tvl_usd: 80_000_000 });
    const small = protocol({ slug: 'small-1', tvl_usd: 40_000_000 });
    const snap = snapshot([...curveComps(), big, small], []);
    const { rows } = buildBoard(snap, fitCurve(snap));
    assert.equal(rows.find((r) => r.slug === 'big-1').above_floor, true);
    assert.equal(rows.find((r) => r.slug === 'small-1').above_floor, false);
  });
  test('liveRows are the traded set by market cap, with the curve value', () => {
    const snap = snapshot(curveComps());
    const live = liveRows(snap, fitCurve(snap));
    assert.equal(live.length, 12);
    assert.ok(live[0].mcap_usd >= live[live.length - 1].mcap_usd);
    assert.ok(live.every((r) => r.curve_value_usd > 0 && r.multiple > 0));
  });
  test('buildRadar accounts for every protocol in the universe', () => {
    const snap = snapshot([...curveComps(), protocol({ slug: 'clean-1' }), protocol({ slug: 'cex-1', category: 'CEX' })], []);
    const { board, radar } = buildRadar(snap);
    const u = radar.universe;
    assert.equal(u.ranked + u.set_aside + u.recorded_with_token + u.traded, snap.protocols.length);
    assert.equal(radar.board_size, board.length);
    assert.equal(radar.rows.length, board.length);
    assert.equal(radar.fit_points.length, fitPoints(snap).length);
    assert.equal(radar.model_version, MODEL_VERSION);
    assert.equal(radar.validation, null);
    assert.equal(radar.refits, null);
  });
  test('radarRow is the compact row the page renders', () => {
    const snap = snapshot([...curveComps(), protocol({ slug: 'clean-1' })], []);
    const { board } = buildRadar(snap);
    const row = radarRow(board[0]);
    assert.equal(row.slug, board[0].slug);
    assert.equal(row.implied_value_usd, board[0].implied_value_usd);
    assert.equal(row.econ.verdict, board[0].verdict);
  });
});

describe('the validation', () => {
  test('looCheck: on exact-curve data the curve predicts perfectly and the flat multiple does not', () => {
    const snap = snapshot(curveComps());
    const rows = looCheck(snap);
    assert.equal(rows.length, 4);
    const byVariant = Object.fromEntries(rows.map((r) => [r.variant, r]));
    assert.equal(byVariant['curve'].median_miss, 1);
    assert.equal(byVariant['curve'].within_2x, 1);
    assert.ok(byVariant['flat'].median_miss > 2);
    assert.ok(byVariant['flat'].within_2x < 1);
    for (const r of rows) assert.equal(r.n, 12);
  });
  test('timeSplitCheck: fit before 2024, tested after, and null when either side is too small', () => {
    const snap = snapshot(curveComps());
    const split = timeSplitCheck(snap);
    // With 8 pre-2024 comps the train side is too small (needs 10): null is the honest answer.
    assert.equal(split, null);
    const many = snapshot(curveComps(20).map((p, i) => ({ ...p, listed_at: i < 12 ? '2022-06-01' : '2025-03-01' })));
    const split2 = timeSplitCheck(many);
    assert.ok(split2 !== null);
    assert.equal(split2.train_n, 12);
    assert.equal(split2.test_n, 8);
    assert.equal(split2.curve_median_miss, 1);
    assert.ok(split2.flat_median_miss > 1);
  });
  test('rankCorr is 1 for identical orderings and -1 for reversed ones', () => {
    assert.equal(rankCorr([1, 2, 3, 4], [1, 2, 3, 4]), 1);
    assert.equal(rankCorr([1, 2, 3, 4], [4, 3, 2, 1]), -1);
    assert.equal(rankCorr([1, 2], [1, 2]), null);
  });
  test('bootstrapRefits return 200 refits, deterministic from the seed', () => {
    const snap = snapshot(curveComps());
    const a = bootstrapRefits(snap);
    const b = bootstrapRefits(snap);
    assert.equal(a.length, 200);
    assert.deepEqual(a, b);
    const fit = fitCurve(snap);
    for (const [ra, rb] of a.slice(0, 20)) {
      assert.ok(Math.abs(ra - fit.a) < 0.5 && Math.abs(rb - fit.b) < 0.5);
    }
  });
  test('bandAndRankRange bands contain the implied value and rank ranges stay in bounds', () => {
    const snap = snapshot(curveComps());
    const fit = fitCurve(snap);
    const { rows } = buildBoard(snap, fit);
    const refits = bootstrapRefits(snap);
    const bands = bandAndRankRange(rows, refits);
    assert.equal(bands.size, rows.length);
    for (const r of rows) {
      const band = bands.get(r.slug);
      assert.ok(band.band_lo_usd <= r.implied_value_usd && r.implied_value_usd <= band.band_hi_usd);
      assert.ok(band.rank_lo >= 1 && band.rank_hi <= rows.length && band.rank_lo <= band.rank_hi);
    }
  });
});

describe('the gate and the parser', () => {
  function validBoard() {
    const snap = snapshot([...curveComps(), protocol({ slug: 'clean-1' })], []);
    const fit = fitCurve(snap);
    const { rows } = buildBoard(snap, fit);
    const refits = bootstrapRefits(snap);
    const bands = bandAndRankRange(rows, refits);
    for (const r of rows) {
      const b = bands.get(r.slug);
      r.band_lo_usd = b.band_lo_usd;
      r.band_hi_usd = b.band_hi_usd;
      r.rank_lo = b.rank_lo;
      r.rank_hi = b.rank_hi;
    }
    return { snap, rows };
  }
  test('boardIssue passes a valid board', () => {
    const { snap, rows } = validBoard();
    assert.equal(boardIssue(rows, snap), null);
  });
  test('boardIssue refuses a missing watchlist slug, a broken rank, a missing verdict and a missing band', () => {
    const { snap, rows } = validBoard();
    const snap2 = snapshot([...curveComps(), protocol({ slug: 'clean-1' })], ['missing-slug']);
    assert.match(boardIssue(rows, snap2), /misses 1 watchlist slug/);
    const broken = rows.map((r) => ({ ...r }));
    broken[0] = { ...broken[0], rank: 99 };
    assert.match(boardIssue(broken, snap), /rank 1 is/);
    const noVerdict = rows.map((r) => ({ ...r }));
    noVerdict[0] = { ...noVerdict[0], verdict: 'MAYBE' };
    assert.match(boardIssue(noVerdict, snap), /no farm verdict/);
    const noBand = rows.map((r) => ({ ...r }));
    noBand[0] = { ...noBand[0], band_lo_usd: null };
    assert.match(boardIssue(noBand, snap), /no uncertainty band/);
  });
  test('parseSnapshot takes a valid snapshot and refuses the rest', () => {
    const snap = parseSnapshot(JSON.stringify(snapshot([protocol()], ['test-protocol'])));
    assert.equal(snap.protocols.length, 1);
    assert.throws(() => parseSnapshot('not json'), /not JSON/);
    assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14' })), /no source/);
    assert.throws(() => parseSnapshot(JSON.stringify({ ...snapshot([], []), watchlist: 'not-an-array' })), /no watchlist/);
    assert.throws(
      () => parseSnapshot(JSON.stringify(snapshot([{ slug: 'x' }]))),
      /lacks a slug, a name or a TVL/,
    );
  });
  test('dataScript is one window.RADAR assignment that parses', () => {
    const { radar } = buildRadar(snapshot(curveComps()));
    const script = dataScript(radar);
    assert.ok(script.startsWith('window.RADAR='));
    assert.equal(JSON.parse(script.slice('window.RADAR='.length).replace(/;\n$/, '')).board_size, radar.board_size);
  });
});

describe('the sealed snapshot (integration, skipped when the kit is absent)', () => {
  test('the real fit, board, universe and validation match the run', (t) => {
    if (!existsSync(realSnapshotPath)) {
      t.skip('kit snapshot not present');
      return;
    }
    const snap = parseSnapshot(readFileSync(realSnapshotPath, 'utf8'));
    const fit = fitCurve(snap);
    approx(fit.a, 7.12, 0.05);
    approx(fit.b, 0.514, 0.02);
    assert.equal(fit.n, 97);
    const { board, radar } = buildRadar(snap);
    assert.equal(board.length, 225);
    assert.equal(radar.watchlist_size, 40);
    const u = radar.universe;
    assert.equal(u.ranked + u.set_aside + u.recorded_with_token + u.traded, 758);
    const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
    for (const r of board) verdicts[r.verdict]++;
    assert.deepEqual(verdicts, { FARM: 18, THIN: 85, SKIP: 122 });
    const loo = looCheck(snap);
    const byVariant = Object.fromEntries(loo.map((r) => [r.variant, r]));
    approx(byVariant['flat'].median_miss, 5.05, 0.05);
    approx(byVariant['curve+growth+maturity'].median_miss, 2.72, 0.05);
    assert.ok(byVariant['curve+growth+maturity'].median_miss < byVariant['flat'].median_miss);
    const split = timeSplitCheck(snap);
    assert.ok(split !== null && split.curve_median_miss < split.flat_median_miss);
    const refits = bootstrapRefits(snap);
    assert.equal(refits.length, 200);
    const bands = bandAndRankRange(board, refits);
    for (const r of board) {
      const b = bands.get(r.slug);
      r.band_lo_usd = b.band_lo_usd;
      r.band_hi_usd = b.band_hi_usd;
      r.rank_lo = b.rank_lo;
      r.rank_hi = b.rank_hi;
    }
    assert.equal(boardIssue(board, snap), null);
  });
});

describe('the detail-shot gate (tools/shot-check.mjs)', () => {
  // Step texts in the exact board.json format: "... Amount: X. Cost: Y. Time: Z."
  const farmSteps = [
    'Day 1 — Verdict: FARM — expected net $238.68 on a $5,000 deposit, break-even odds 7.2%. Where: Manifest Trade. Amount: $5,000 deposit. Cost: $0.00. Time: 5 minutes.',
    'Day 1 — Open a fresh wallet holding only the funds for this farm; keep the seed phrase offline. Where: Solana. Amount: —. Cost: $0.5 of gas (wallet setup). Time: 5 minutes.',
    'Day 1 — Provide $5,000 of liquidity to Manifest Trade\'s main pool on Solana and keep the position open. Where: Solana. Amount: $5,000 (0.055% of TVL). Cost: $0.5 of gas (deposit). Time: 15 minutes.',
    'Day 7 — Move the liquidity into the pool\'s highest-fee range when it drifts. Where: Solana. Amount: $5,000 stays in the position. Cost: $0.5 of gas. Time: 15 minutes × 4.3 weeks.',
    'Day 15 — Recheck: TVL moved +73.7% in 7 days; running 731 days with no token; if the move reversed, re-run the numbers before staying. Where: Manifest Trade. Amount: $5,000 stays in the position. Cost: $0.00. Time: 10 minutes.',
    'Day 30 — Stop: if TVL falls 35% from entry (below $5,904,668), unwind the position the same day and keep the log. Where: Solana. Amount: $5,000. Cost: $0.00. Time: 5 minutes.',
    'Day 30 — Withdraw the $5,000 and log wallet, dates and every transaction. Where: Manifest Trade. Amount: $5,000. Cost: $0.5 of gas to exit. Time: 10 minutes.',
  ];
  const skipSteps = Array(7).fill('Day 1 — Flip: the implied value would need to reach $64,340,897 for a $500 deposit to pay at 10% odds. Where: Steakhouse Financial. Amount: $64,340,897. Cost: $0.00. Time: 2 minutes.');

  test('costOfStepText extracts the Cost segment', () => {
    assert.equal(costOfStepText(farmSteps[1]), '$0.5 of gas (wallet setup)');
    assert.equal(costOfStepText(farmSteps[0]), '$0.00');
    assert.equal(costOfStepText(farmSteps[5]), '$0.00');
    assert.equal(costOfStepText('no cost here'), null);
  });

  test('a FARM row with 7 steps, every step with a $ cost, passes', () => {
    const g = checkDetailRow({ verdict: 'FARM', farm_steps: farmSteps });
    assert.equal(g.ok, true);
    assert.deepEqual(g.failures, []);
  });

  test('a SKIP row fails on verdict (its $0.00 costs pass the cost check)', () => {
    const g = checkDetailRow({ verdict: 'SKIP', farm_steps: skipSteps });
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.includes('verdict is SKIP')));
    assert.ok(!g.failures.some((f) => f.includes('$ cost steps')));
  });

  test('a FARM row with 6 steps fails', () => {
    const g = checkDetailRow({ verdict: 'FARM', farm_steps: farmSteps.slice(0, 6) });
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.includes('farm_steps 6 < 7')));
  });

  test('a FARM row with a step missing its $ cost fails', () => {
    const thin = farmSteps.map((s, i) => (i === 2 || i === 3 ? s.replace(/Cost: \$.*?\. Time:/, 'Cost: —. Time:') : s));
    const g = checkDetailRow({ verdict: 'FARM', farm_steps: thin });
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.includes('$ cost steps 5 of 7')));
  });

  test('a passing DOM measurement passes', () => {
    const g = checkDetailDom({ dialogOpen: true, verdict: 'FARM', stepRows: 7, dollarCosts: 7, tableBottom: 920, dialogScrollTop: 0, arithPresent: true });
    assert.equal(g.ok, true);
  });

  test('each DOM failure is caught', () => {
    const base = { dialogOpen: true, verdict: 'FARM', stepRows: 7, dollarCosts: 7, tableBottom: 920, dialogScrollTop: 0, arithPresent: true };
    const cases = [
      [{ ...base, dialogOpen: false }, 'not open'],
      [{ ...base, verdict: 'SKIP' }, 'verdict'],
      [{ ...base, stepRows: 6 }, 'plan rows'],
      [{ ...base, dollarCosts: 0 }, '$ cost cells'],
      [{ ...base, dollarCosts: 6 }, '$ cost cells'],
      [{ ...base, tableBottom: 1050 }, 'exceeds viewport'],
      [{ ...base, dialogScrollTop: 120 }, 'scrolled'],
      [{ ...base, arithPresent: false }, 'arithmetic bar'],
    ];
    for (const [m, needle] of cases) {
      const g = checkDetailDom(m);
      assert.equal(g.ok, false, JSON.stringify(m));
      assert.ok(g.failures.some((f) => f.includes(needle)), JSON.stringify(g.failures));
    }
  });

  test('the real rows: manifest-trade passes, steakhouse-financial fails', (t) => {
    if (!existsSync(realSnapshotPath)) {
      t.skip('kit snapshot not present');
      return;
    }
    const snap = parseSnapshot(readFileSync(realSnapshotPath, 'utf8'));
    const { board } = buildRadar(snap);
    const manifest = board.find((r) => r.slug === 'manifest-trade');
    const steakhouse = board.find((r) => r.slug === 'steakhouse-financial');
    assert.ok(manifest && steakhouse);
    assert.equal(checkDetailRow(manifest).ok, true);
    const g = checkDetailRow(steakhouse);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.includes('verdict is SKIP')));
  });
});
