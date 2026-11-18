// The token radar's model, radar-3: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and ranks
// every other pre-token protocol the universe rules allow: no cap, no silent drops — a protocol
// that is not ranked is named in the set-aside list with its reason. A protocol is pre-token
// when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never
// mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures (TVL, seven-day growth, time
// running with no token), fitted at run time on the snapshot's traded tokens:
//
//   curve   = 10^(a + b x log10(tvl_usd / $100M)), with a and b fitted by OLS on the traded
//             comps (no CEX, no bridges, no versioned listings, mcap/TVL trimmed to
//             [1/500, 50]). On this snapshot a is about 7.2 and b about 0.52: value grows
//             with the square root of TVL, not with TVL. A flat multiple pays big protocols
//             far too much; the curve charges them the multiple their own size implies.
//   growth  = clamp(change_7d, -50, +60) per cent, tilted by half its size and clamped to
//             [0.7, 1.3]: a spike past +60 is noise, not signal, and a fall counts the same
//             way a rise does once the tilt is bounded.
//   maturity = an S-ramp on age: under 90 days 0.55 (unproven), 90..365 days 0.55..0.85,
//             365..1095 days 0.85..1.0, past that 1.0. Age unknown: 365 days, the ramp's
//             midpoint, stated, never hidden.
//   implied = max(1, round(curve x growth x maturity))
//
// Category effects were fitted, tested out of sample, and left out: on walk-forward folds they
// do not beat the bare curve, so the model states that instead of charging for them.
//
// Every farm plan is netted to a verdict in dollars: the slice is a 10% airdrop share of the
// implied value times the deposit's share of TVL; the costs are gas on the cheapest listed
// chain plus the T-bill yield the deposit gives up; FARM when break-even odds are at most
// 10%, THIN at most 25%, else SKIP. No protocol name is ever special-cased: the same
// functions score every row.
//
// One file runs in both places: main.ts imports it under Node, and the dashboard loads it as
// a module and re-derives every row from the same inputs, so the page's numbers and the
// board's numbers are visibly the same arithmetic. The board's assembly (buildBoard,
// buildRadar, the gate) lives in lib/board.ts and the out-of-sample validation in
// lib/validate.ts; both run only under Node, outside the dashboard's byte cap.

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** The seed for the bootstrap refits: fixed, so every run refits the same bands. */
export const BOOTSTRAP_SEED = 20261114;

/** How many bootstrap refits the bands and rank ranges come from. */
export const BOOTSTRAP_REFITS = 200;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `n` into [`lo`, `hi`]. */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf, listedAt) {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---------------------------------------------------------------- the fitted curve

/** The TVL the curve is fitted against: value at $100M of TVL is 10^a. */
export const FIT_REF_USD = 1e8;

/** The mcap/TVL window the fit trusts: outside it a multiple is a typo or a different asset. */
export const FIT_TRIM = [1 / 500, 50];

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A bridge by category: bridges move value, they do not hold the value the curve prices. */
const BRIDGE_CATEGORY = /bridge/i;

/** Whether a protocol belongs in the fit: it trades, it is not an exchange or a bridge, and its name is not a versioned listing. */
export function isFitComp(p) {
  return (
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0 &&
    p.category !== 'CEX' &&
    !BRIDGE_CATEGORY.test(p.category || '') &&
    !VERSIONED.test(p.name)
  );
}

/** The fit's points: log TVL against log market cap, trimmed to the trusted multiple window. */
export function fitPoints(snapshot) {
  const pts = [];
  for (const p of snapshot.protocols) {
    if (!isFitComp(p)) continue;
    const mult = p.mcap_usd / p.tvl_usd;
    if (!(mult >= FIT_TRIM[0] && mult <= FIT_TRIM[1])) continue;
    pts.push({ x: Math.log10(p.tvl_usd / FIT_REF_USD), y: Math.log10(p.mcap_usd), slug: p.slug });
  }
  return pts;
}

/** Ordinary least squares on `points` ({x, y}): the intercept, slope, count and R squared, or null when the fit cannot be trusted. */
export function ols(points) {
  const n = points.length;
  if (n < 10) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const pt of points) {
    sx += pt.x;
    sy += pt.y;
    sxx += pt.x * pt.x;
    sxy += pt.x * pt.y;
    syy += pt.y * pt.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  const yMean = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const pt of points) {
    const pred = a + b * pt.x;
    ssTot += (pt.y - yMean) * (pt.y - yMean);
    ssRes += (pt.y - pred) * (pt.y - pred);
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { a, b, n, r2 };
}

/** The curve fitted on the snapshot's traded comps, or a refusal when there are too few to fit. */
export function fitCurve(snapshot) {
  const pts = fitPoints(snapshot);
  const fit = ols(pts);
  if (fit === null) throw new SnapshotError('snapshot has too few traded comps to fit the value curve');
  return fit;
}

/** The curve's value at a TVL: 10^(a + b x log10(tvl / $100M)). */
export function curveValue(tvl, fit) {
  if (!(tvl > 0)) return 1;
  return Math.pow(10, fit.a + fit.b * Math.log10(tvl / FIT_REF_USD));
}

// ---------------------------------------------------------------- the tilts

/** The bounded tilts on top of the curve: growth and age move a value, never more than stated. */
export const TILTS = {
  growth_floor: -50,
  growth_cap: 60,
  growth_half: 0.5,
  growth_min: 0.7,
  growth_max: 1.3,
  maturity_young_days: 90,
  maturity_young: 0.55,
  maturity_mid: 0.85,
  maturity_full: 1.0,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The growth tilt: half the clamped seven-day move, bounded so a spike cannot carry a row. */
export function growthMult(change7d) {
  const g = clamp(finite(change7d, 0), TILTS.growth_floor, TILTS.growth_cap);
  return clamp(1 + (g / 100) * TILTS.growth_half, TILTS.growth_min, TILTS.growth_max);
}

/** The maturity tilt: an S-ramp on age, young protocols discounted, old ones saturating at 1.0. */
export function maturityMult(age) {
  const a = age ?? TILTS.unknown_age_days;
  if (a < TILTS.maturity_young_days) return TILTS.maturity_young;
  if (a < 365) return TILTS.maturity_young + ((a - TILTS.maturity_young_days) / (365 - TILTS.maturity_young_days)) * (TILTS.maturity_mid - TILTS.maturity_young);
  if (a < TILTS.maturity_days) return TILTS.maturity_mid + ((a - 365) / (TILTS.maturity_days - 365)) * (TILTS.maturity_full - TILTS.maturity_mid);
  return TILTS.maturity_full;
}

/** The multipliers and the implied value one protocol gets: curve times the bounded tilts. */
export function impliedValue(p, asOf, fit) {
  const age = ageDays(asOf, p.listed_at);
  const curve = curveValue(p.tvl_usd, fit);
  const gm = growthMult(p.change_7d);
  const mm = maturityMult(age);
  const implied = Math.max(1, Math.round(curve * gm * mm));
  return {
    implied,
    curve: Math.round(curve),
    growthPct: clamp(finite(p.change_7d, 0), TILTS.growth_floor, TILTS.growth_cap),
    growthMult: round4(gm),
    maturityMult: round4(mm),
    age,
  };
}

// ---------------------------------------------------------------- the universe

/** Whether a protocol records no token at all. */
export function isPreToken(p) {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The first word of a name, lower-cased: the stem a sibling listing shares. */
function firstWord(name) {
  const w = (name || '').trim().split(/\s+/)[0];
  return w === undefined ? '' : w.toLowerCase();
}

/** First words too generic to prove a sibling: a shared generic word is not a shared token. */
const GENERIC_STEMS = new Set([
  'the', 'a', 'an', 'stake', 'yield', 'liquid', 'decentralized', 'onchain', 'crypto', 'bitcoin',
  'ethereum', 'us', 'meta', 'prime', 'alpha', 'beta', 'gamma', 'delta', 'omega', 'super', 'ultra',
  'hyper', 'mega', 'neo', 'new', 'open', 'free', 'top', 'best', 'pro', 'max', 'one', 'two', 'defi',
]);

/** The first words of the traded tokens' names: a pre-token name starting with one is a sibling listing. */
export function tradedStems(snapshot) {
  const stems = new Set();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0) {
      const stem = firstWord(p.name);
      if (stem.length >= 5 && !GENERIC_STEMS.has(stem)) stems.add(stem);
    }
  }
  return stems;
}

/** Why a pre-token protocol is set aside instead of ranked, or null when it may rank. */
export function setAsideReason(p, stems) {
  if (p.category === 'CEX') return 'exchange';
  if (BRIDGE_CATEGORY.test(p.category || '')) return 'bridge';
  if (VERSIONED.test(p.name)) return 'versioned listing';
  const c = p.category || '';
  if (c === 'Anchor BTC' || c === 'Decentralized BTC' || /wrapped/i.test(p.name) || /staked/i.test(p.name)) return 'wrapped or staked product';
  const stem = firstWord(p.name);
  if (stem.length >= 5 && !GENERIC_STEMS.has(stem) && stems.has(stem)) return 'name shared with a traded token';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token, and either on the watchlist or with no set-aside reason. */
export function isRankable(p, watchlist, stems) {
  if (!isPreToken(p)) return false;
  if (watchlist.has(p.slug)) return true;
  return setAsideReason(p, stems) === null;
}

// ---------------------------------------------------------------- the farm economics

/** The farm plan's economics: a 10% airdrop share, the T-bill yield a deposit gives up, and the verdict lines. */
export const ECON = {
  t_bill: 0.04,
  airdrop_share: 0.1,
  tx_count: 4,
  farm_odds: 0.1,
  thin_odds: 0.25,
  deposit_min: 500,
  deposit_max: 5000,
};

/** Gas per transaction in dollars, by chain tier: Ethereum is dear, L2s and fast L1s are cheap. */
const GAS_TIERS = [
  { match: ['ethereum'], usd: 10 },
  { match: ['arbitrum', 'optimism', 'base', 'blast', 'zksync', 'scroll', 'linea', 'mode', 'mantle', 'manta', 'fraxtal', 'starknet', 'taiko', 'kroma', 'metis', 'zora', 'degen'], usd: 0.25 },
  { match: ['solana', 'sui', 'aptos', 'movement', 'sei', 'near', 'tron', 'binance', 'bnb', 'polygon', 'avalanche', 'hyperliquid', 'celo', 'gnosis', 'fantom', 'ton'], usd: 0.5 },
];

/** Gas in dollars for one transaction on a chain, by tier. */
export function gasUsd(chain) {
  const c = (chain || '').toLowerCase();
  for (const tier of GAS_TIERS) {
    if (tier.match.some((k) => c.includes(k))) return tier.usd;
  }
  return 2;
}

/** The cheapest of a protocol's first three chains, and its gas: the deposit goes where it costs least to move. */
export function cheapestChain(p) {
  const chains = (p.chains || []).slice(0, 3);
  if (chains.length === 0) return { chain: 'its main chain', gasUsd: 2 };
  let best = chains[0];
  let bestGas = gasUsd(best);
  for (const c of chains) {
    const g = gasUsd(c);
    if (g < bestGas) {
      best = c;
      bestGas = g;
    }
  }
  return { chain: best, gasUsd: bestGas };
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age) {
  if (age === null || age === undefined) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * A farm plan's economics in dollars: the slice is the airdrop share of the implied value times
 * the deposit's share of TVL; the costs are gas on the cheapest chain plus the T-bill yield the
 * deposit gives up over the hold; the verdict is the break-even odds. The minimum deposit is the
 * smallest deposit whose slice covers its costs, or null when no deposit pays.
 */
export function farmEcon(p, implied, age) {
  const { chain, gasUsd: gas } = cheapestChain(p);
  const hold = holdDaysFor(age);
  // The deposit is the cap whenever a deposited dollar pays for itself (net per dollar
  // positive); otherwise the floor, and the verdict is SKIP. A farmer sizes to what pays:
  // the slice scales with the deposit while the gas does not, so a small deposit on a
  // small protocol is the worst of both — it pays the same gas for a thinner slice.
  const perDollar = p.tvl_usd > 0 ? (ECON.airdrop_share * implied) / p.tvl_usd - ECON.t_bill * (hold / 365) : -1;
  const deposit = perDollar > 0 ? ECON.deposit_max : ECON.deposit_min;
  const slice = p.tvl_usd > 0 ? ECON.airdrop_share * implied * (deposit / p.tvl_usd) : 0;
  const fees = gas * ECON.tx_count;
  const capitalCost = deposit * ECON.t_bill * (hold / 365);
  const net = slice - fees - capitalCost;
  const costs = fees + capitalCost;
  const odds = slice > 0 ? costs / slice : Infinity;
  const verdict = odds <= ECON.farm_odds ? 'FARM' : odds <= ECON.thin_odds ? 'THIN' : 'SKIP';
  const hours = 0.5 + (hold / 7) * 0.25 + 0.5;
  const minDeposit = perDollar > 0 ? Math.ceil(fees / perDollar) : null;
  return {
    chain,
    gasUsd: gas,
    holdDays: hold,
    deposit,
    slice: round2(slice),
    fees: round2(fees),
    capitalCost: round2(capitalCost),
    net: round2(net),
    breakEvenOdds: odds === Infinity ? null : round4(odds),
    verdict,
    perHour: round2(net / hours),
    minDeposit,
    activeHours: round2(hours),
  };
}

// ---------------------------------------------------------------- the farm steps

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step) {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p) {
  return p.chains.length > 0 ? p.chains[0] : 'its main chain';
}

/** The mechanism's one action, in the words a farmer can follow, dated to day 1. */
function actionFor(p, econ) {
  const c = (p.category || '').toLowerCase();
  const name = p.name;
  const d = econ.deposit;
  const chain = econ.chain;
  if (c.includes('rwa')) return `Complete KYC on day 3, then mint $${d} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('cdp')) return `Open a collateral vault on ${name} with $${d} of USDC on ${chain} on day 1 and mint against it.`;
  if (c.includes('lend') || c.includes('collateral')) return `Supply $${d} of USDC to ${name} on ${chain} on day 1 and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${d} of liquidity to ${name}'s main pool on ${chain} on day 1 and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${d} of USDC to ${chain} through ${name} on day 1 and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${d} of the chain's staking asset through ${name} on day 1 and keep the receipt; note the unbonding period before you start.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${d} of USDC as margin on ${name} on day 1 and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${d} and place one market position on ${name} on day 1.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${d} into a ${name} vault on ${chain} on day 1 and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${d} of the stable asset through ${name} on ${chain} on day 1.`;
  if (c.includes('insurance')) return `Buy $${d} of cover from ${name} on ${chain} on day 1 and keep the policy.`;
  return `Deposit $${d} of USDC into ${name} on ${chain} on day 1 and keep the position open.`;
}

/** The weekly qualifying action, fitted to the category instead of one generic line. */
function weeklyActionFor(p) {
  const c = (p.category || '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Borrow a small amount against the supply and repay it within the week, so the loan counts as activity.';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return "Move the liquidity into the pool's highest-fee range once, then leave it alone.";
  if (c.includes('bridge')) return 'Use the bridged funds in the destination app once, then bridge a small amount back.';
  if (c.includes('staking') || c.includes('restak')) return `Restake the receipt once through ${name}'s restaking vault.`;
  if (c.includes('perpetual') || c.includes('derivative')) return 'Check the funding rate once a day and keep the hedge near delta-neutral.';
  if (c.includes('prediction')) return 'Settle the position before the market closes and place the next one.';
  if (c.includes('curator') || c.includes('allocator')) return "Rebalance into the vault's newest strategy once.";
  if (c.includes('stable')) return 'Hold the minted asset through one full rewards epoch.';
  if (c.includes('rwa')) return 'Claim the yield distribution once and redeposit it.';
  if (c.includes('insurance')) return 'File no claim; renew the cover before it lapses.';
  return 'Make one qualifying action, such as a deposit, a borrow, a swap or a vote.';
}

/** The stop rule's trigger: twice the seven-day swing, between 10% and 35%. */
export function stopRuleFor(p) {
  const swing = Math.abs(finite(p.change_7d, 10));
  const pct = clamp(2 * swing, 10, 35);
  const level = Math.max(1, Math.round(p.tvl_usd * (1 - pct / 100)));
  return { pct: round2(pct), level };
}

/**
 * A protocol's farm plan: seven dated steps, each an action with a cost and a time. The first
 * step states the verdict in dollars; the last two are the stop rule and the claim. The plan is
 * derived from the protocol's own record (category, chains, TVL, age, implied value), never
 * from a hand-written list of names.
 */
export function farmSteps(p, econ, age) {
  const chain = chainOf(p);
  const gas = gasUsd(chain);
  const hold = econ.holdDays;
  const verdictLine =
    econ.verdict === 'FARM'
      ? `Verdict: FARM — expected net $${econ.net.toFixed(2)} on a $${econ.deposit} deposit, break-even odds ${(econ.breakEvenOdds * 100).toFixed(1)}%.`
      : econ.verdict === 'THIN'
        ? `Verdict: THIN — expected net $${econ.net.toFixed(2)} on a $${econ.deposit} deposit, break-even odds ${(econ.breakEvenOdds * 100).toFixed(1)}%; a half position only.`
        : econ.minDeposit === null
          ? `Verdict: SKIP — expected net $${econ.net.toFixed(2)} on a $${econ.deposit} deposit; no deposit size pays at this value.`
          : `Verdict: SKIP — expected net $${econ.net.toFixed(2)} on a $${econ.deposit} deposit; it only pays from a $${econ.minDeposit} deposit.`;
  const stop = stopRuleFor(p);
  const midway = Math.max(7, Math.round(hold / 2));
  return [
    { text: verdictLine, cost: 'nothing to decide', time: '1 minute' },
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: `${gas} of gas for the first transaction`, time: '5 minutes' },
    { text: actionFor(p, econ), cost: `$${econ.deposit} of capital and $${gas} of gas`, time: '15 minutes to set up' },
    { text: weeklyActionFor(p), cost: `$${gas} of gas a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days; on day ${midway} recheck the TVL and the points page before deciding whether to stay.`, cost: `the $${econ.deposit} stays in the position`, time: `${hold} days` },
    { text: `Set a stop: if TVL falls ${stop.pct}% from entry (below $${stop.level.toLocaleString('en-US')}), unwind the position the same day and keep the log.`, cost: 'no fee to watch', time: '2 minutes a day' },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; then write the wallet, the dates and every transaction in a farm log.`, cost: 'no fee to check, and never pay to claim', time: '15 minutes' },
  ].map(stepText);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * The band and rank range of every row under the refits: the band is the P25–P75 of the
 * refit values, the rank range the P10–P90 of the row's rank across refits. Returns a map
 * from slug to {band_lo_usd, band_hi_usd, rank_lo, rank_hi}.
 */
export function bandAndRankRange(rows, refits) {
  const out = new Map();
  // Rows come in two shapes: board rows carry the tilts under .model, compact radar rows
  // carry them at the top level. Both shapes hold the same numbers.
  const gm = (r) => (r.model ? r.model.growth_multiplier : r.growth_multiplier);
  const mm = (r) => (r.model ? r.model.maturity_multiplier : r.maturity_multiplier);
  const valuesByRow = rows.map(() => []);
  const ranksByRow = rows.map(() => []);
  for (const [a, b] of refits) {
    const vals = rows.map((r) => Math.pow(10, a + b * Math.log10(r.tvl_usd / FIT_REF_USD)) * gm(r) * mm(r));
    const order = vals.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v || (rows[x.i].slug < rows[y.i].slug ? -1 : 1));
    order.forEach((o, pos) => {
      valuesByRow[o.i].push(Math.max(1, Math.round(o.v)));
      ranksByRow[o.i].push(pos + 1);
    });
  }
  rows.forEach((r, i) => {
    const vals = [...valuesByRow[i]].sort((x, y) => x - y);
    const rks = [...ranksByRow[i]].sort((x, y) => x - y);
    out.set(r.slug, {
      band_lo_usd: percentile(vals, 25),
      band_hi_usd: percentile(vals, 75),
      rank_lo: percentile(rks, 10),
      rank_hi: percentile(rks, 90),
    });
  });
  return out;
}
