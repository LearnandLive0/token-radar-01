// Out-of-sample validation for radar-3: leave-one-out, a time split, and bootstrap refits.
//
// This file runs only under Node (main.ts imports it); it is not part of the dashboard's
// 65,536-byte source cap. The dashboard shows the numbers these functions compute — the
// Method view's tables come from here, shipped in data.js — and the page re-derives only the
// per-row bands from the shipped refits.

import {
  BOOTSTRAP_REFITS,
  BOOTSTRAP_SEED,
  FIT_REF_USD,
  SnapshotError,
  ageDays,
  curveValue,
  fitPoints,
  growthMult,
  maturityMult,
  ols,
} from '../dashboard/model.js';

/** A seeded PRNG (mulberry32): the same seed refits the same bands on every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ranks with average ties: Spearman's input. */
function ranks(values) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman's rank correlation between two equal-length arrays, or null when it cannot be computed. */
export function rankCorr(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) * (rx[i] - mx);
    syy += (ry[i] - my) * (ry[i] - my);
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** The median of a sorted array, or null when it is empty. */
function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Leave-one-out validation, one row per model variant: the flat median multiple, the curve,
 * the curve with growth, and the curve with growth and maturity. Each variant refits without
 * the token it predicts, so the miss is out of sample. The flat multiple is the baseline the
 * curve has to beat.
 */
export function looCheck(snapshot) {
  const pts = fitPoints(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const variants = ['flat', 'curve', 'curve+growth', 'curve+growth+maturity'];
  const misses = { flat: [], curve: [], 'curve+growth': [], 'curve+growth+maturity': [] };
  const preds = { flat: [], curve: [], 'curve+growth': [], 'curve+growth+maturity': [] };
  const actuals = [];
  for (const pt of pts) {
    const p = bySlug.get(pt.slug);
    const actual = p.mcap_usd;
    actuals.push(actual);
    const rest = pts.filter((q) => q.slug !== pt.slug);
    // The flat multiple is the median mcap/TVL of the rest, in dollars per dollar of TVL.
    const restMults = rest.map((q) => Math.pow(10, q.y - q.x) / FIT_REF_USD).sort((a, b) => a - b);
    const flatMult = median(restMults);
    const flatPred = flatMult * p.tvl_usd;
    const fit = ols(rest);
    const curvePred = fit === null ? flatPred : curveValue(p.tvl_usd, fit);
    const g = growthMult(p.change_7d);
    const m = maturityMult(ageDays(snapshot.as_of, p.listed_at));
    const made = { flat: flatPred, curve: curvePred, 'curve+growth': curvePred * g, 'curve+growth+maturity': curvePred * g * m };
    for (const v of variants) {
      const pred = Math.max(1, made[v]);
      preds[v].push(pred);
      misses[v].push(Math.max(pred / actual, actual / pred));
    }
  }
  return variants.map((v) => {
    const sorted = [...misses[v]].sort((a, b) => a - b);
    const within2 = sorted.filter((x) => x <= 2).length / sorted.length;
    const within3 = sorted.filter((x) => x <= 3).length / sorted.length;
    const rc = rankCorr(preds[v], actuals);
    return {
      variant: v,
      n: sorted.length,
      median_miss: round2(median(sorted)),
      within_2x: round4(within2),
      within_3x: round4(within3),
      rank_corr: rc === null ? null : round4(rc),
    };
  });
}

/**
 * A time split: fit the curve on comps listed before 2024, test it on comps listed after.
 * The flat median multiple is the baseline again. Null when either side is too small to say.
 */
export function timeSplitCheck(snapshot) {
  const pts = fitPoints(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const train = pts.filter((pt) => {
    const p = bySlug.get(pt.slug);
    return p.listed_at !== null && p.listed_at < '2024-01-01';
  });
  const test = pts.filter((pt) => {
    const p = bySlug.get(pt.slug);
    return p.listed_at !== null && p.listed_at >= '2024-01-01';
  });
  if (train.length < 10 || test.length < 5) return null;
  const fit = ols(train);
  if (fit === null) return null;
  const trainMults = train.map((q) => Math.pow(10, q.y - q.x) / FIT_REF_USD).sort((a, b) => a - b);
  const flatMult = median(trainMults);
  const curveMiss = [];
  const flatMiss = [];
  for (const pt of test) {
    const p = bySlug.get(pt.slug);
    const actual = p.mcap_usd;
    const cp = Math.max(1, curveValue(p.tvl_usd, fit));
    const fp = Math.max(1, flatMult * p.tvl_usd);
    curveMiss.push(Math.max(cp / actual, actual / cp));
    flatMiss.push(Math.max(fp / actual, actual / fp));
  }
  curveMiss.sort((a, b) => a - b);
  flatMiss.sort((a, b) => a - b);
  return { train_n: train.length, test_n: test.length, curve_median_miss: round2(median(curveMiss)), flat_median_miss: round2(median(flatMiss)) };
}

/**
 * Bootstrap refits: resample the fit's residuals with replacement and refit, `count` times,
 * from `seed`. Returns the refit (a, b) pairs, rounded for stable JSON.
 */
export function bootstrapRefits(snapshot, count = BOOTSTRAP_REFITS, seed = BOOTSTRAP_SEED) {
  const pts = fitPoints(snapshot);
  const fit = ols(pts);
  if (fit === null) throw new SnapshotError('snapshot has too few traded comps to fit the value curve');
  const residuals = pts.map((pt) => pt.y - (fit.a + fit.b * pt.x));
  const rng = mulberry32(seed);
  const refits = [];
  for (let k = 0; k < count; k++) {
    const boot = pts.map((pt) => {
      const r = residuals[Math.floor(rng() * residuals.length)];
      return { x: pt.x, y: fit.a + fit.b * pt.x + r };
    });
    const f = ols(boot);
    if (f !== null) refits.push([round4(f.a), round4(f.b)]);
  }
  return refits;
}
