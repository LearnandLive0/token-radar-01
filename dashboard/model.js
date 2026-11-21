export const MODEL_VERSION = 'radar-3';
export const BOOTSTRAP_SEED = 20261114;
export const BOOTSTRAP_REFITS = 200;
export class SnapshotError extends Error {
constructor(message) {
super(message);
this.name = 'SnapshotError';
}
}
const DAY_MS = 86_400_000;
function finite(value, fallback) {
return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function clamp(n, lo, hi) {
return Math.min(hi, Math.max(lo, n));
}
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
export function ageDays(asOf, listedAt) {
if (listedAt === null) return null;
const a = Date.parse(`${asOf}T00:00:00Z`);
const b = Date.parse(`${listedAt}T00:00:00Z`);
if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
return Math.max(0, Math.floor((a - b) / DAY_MS));
}
export const FIT_REF_USD = 1e8;
export const FIT_TRIM = [1 / 500, 50];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const BRIDGE_CATEGORY = /bridge/i;
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
export function fitCurve(snapshot) {
const pts = fitPoints(snapshot);
const fit = ols(pts);
if (fit === null) throw new SnapshotError('snapshot has too few traded comps to fit the value curve');
return fit;
}
export function curveValue(tvl, fit) {
if (!(tvl > 0)) return 1;
return Math.pow(10, fit.a + fit.b * Math.log10(tvl / FIT_REF_USD));
}
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
export function growthMult(change7d) {
const g = clamp(finite(change7d, 0), TILTS.growth_floor, TILTS.growth_cap);
return clamp(1 + (g / 100) * TILTS.growth_half, TILTS.growth_min, TILTS.growth_max);
}
export function maturityMult(age) {
const a = age ?? TILTS.unknown_age_days;
if (a < TILTS.maturity_young_days) return TILTS.maturity_young;
if (a < 365) return TILTS.maturity_young + ((a - TILTS.maturity_young_days) / (365 - TILTS.maturity_young_days)) * (TILTS.maturity_mid - TILTS.maturity_young);
if (a < TILTS.maturity_days) return TILTS.maturity_mid + ((a - 365) / (TILTS.maturity_days - 365)) * (TILTS.maturity_full - TILTS.maturity_mid);
return TILTS.maturity_full;
}
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
export function isPreToken(p) {
return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
function firstWord(name) {
const w = (name || '').trim().split(/\s+/)[0];
return w === undefined ? '' : w.toLowerCase();
}
const GENERIC_STEMS = new Set([
'the', 'a', 'an', 'stake', 'yield', 'liquid', 'decentralized', 'onchain', 'crypto', 'bitcoin',
'ethereum', 'us', 'meta', 'prime', 'alpha', 'beta', 'gamma', 'delta', 'omega', 'super', 'ultra',
'hyper', 'mega', 'neo', 'new', 'open', 'free', 'top', 'best', 'pro', 'max', 'one', 'two', 'defi',
]);
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
export function isRankable(p, watchlist, stems) {
if (!isPreToken(p)) return false;
if (watchlist.has(p.slug)) return true;
return setAsideReason(p, stems) === null;
}
export const ECON = {
t_bill: 0.04,
airdrop_share: 0.1,
tx_count: 4,
farm_odds: 0.1,
thin_odds: 0.25,
deposit_min: 500,
deposit_max: 5000,
};
const GAS_TIERS = [
{ match: ['ethereum'], usd: 10 },
{ match: ['arbitrum', 'optimism', 'base', 'blast', 'zksync', 'scroll', 'linea', 'mode', 'mantle', 'manta', 'fraxtal', 'starknet', 'taiko', 'kroma', 'metis', 'zora', 'degen'], usd: 0.25 },
{ match: ['solana', 'sui', 'aptos', 'movement', 'sei', 'near', 'tron', 'binance', 'bnb', 'polygon', 'avalanche', 'hyperliquid', 'celo', 'gnosis', 'fantom', 'ton'], usd: 0.5 },
];
export function gasUsd(chain) {
const c = (chain || '').toLowerCase();
for (const tier of GAS_TIERS) {
if (tier.match.some((k) => c.includes(k))) return tier.usd;
}
return 2;
}
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
export function holdDaysFor(age) {
if (age === null || age === undefined) return 30;
if (age < 180) return 60;
if (age < 365) return 45;
return 30;
}
// Hands-on minutes: setup 30 + 15 min/week x weeks + exit 30; the step times sum to this.
export function planMinutes(hold) {
return 30 + (15 * hold) / 7 + 30;
}
// E3: funding asset by category + chain (BTC -> BTC, staking -> native coin, else USDC).
const C2_NATIVE = { solana: 'SOL', ethereum: 'ETH', ton: 'TON', bitcoin: 'BTC', 'hyperliquid l1': 'HYPE', sui: 'SUI', near: 'NEAR', tron: 'TRX', starknet: 'STRK', algorand: 'ALGO', stacks: 'STX' };
export function fundingAssetFor(p, chain) {
const c = (p.category || '').toLowerCase();
if (c.includes('btc')) return { asset: 'BTC', bridge: (chain || '').toLowerCase() === 'bitcoin' ? 0 : gasUsd(chain) };
if (c.includes('stak')) return { asset: C2_NATIVE[(chain || '').toLowerCase()] || null, bridge: 0 };
return { asset: 'USDC', bridge: 0 };
}
export function farmEcon(p, implied, age) {
const { chain, gasUsd: gas } = cheapestChain(p);
const hold = holdDaysFor(age);
const fa = fundingAssetFor(p, chain);
const perDollar = p.tvl_usd > 0 ? (ECON.airdrop_share * implied) / p.tvl_usd - ECON.t_bill * (hold / 365) : -1;
const deposit = perDollar > 0 ? ECON.deposit_max : ECON.deposit_min;
const slice = p.tvl_usd > 0 ? ECON.airdrop_share * implied * (deposit / p.tvl_usd) : 0;
const fees = gas * ECON.tx_count + fa.bridge;
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
fundingAsset: fa.asset,
};
}
export function gridNet(e, p, d) {
const s = p / ECON.deposit_max;
return round2((1 - d) * e.slice * s - e.fees - e.capitalCost * s);
}
export function stepText(step) {
let s = `Day ${step.day} — ${step.action} Where: ${step.where}. Amount: ${step.amount}. Cost: ${step.cost}. Time: ${step.time}.`;
if (s.length > 600) s = `${s.slice(0, 596)}...`;
return s;
}
function depositAction(p, econ) {
const c = (p.category || '').toLowerCase();
const name = p.name;
const d = econ.deposit.toLocaleString('en-US');
const chain = econ.chain;
if (c.includes('rwa')) return `Complete KYC first, then mint $${d} of the protocol's yield asset on ${chain} and hold it.`;
if (c.includes('cdp')) return `Open a collateral vault on ${name} with $${d} of USDC on ${chain} and mint against it.`;
if (c.includes('lend') || c.includes('collateral')) return `Supply $${d} of USDC to ${name} on ${chain} and keep the position open.`;
if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${d} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
if (c.includes('bridge')) return `Bridge $${d} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
if (c.includes('staking') || c.includes('restak')) return `Stake $${d} of the chain's staking asset through ${name} and keep the receipt; note the unbonding period before you start.`;
if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${d} of USDC as margin on ${name} and open one small hedge.`;
if (c.includes('prediction')) return `Fund $${d} and place one market position on ${name}.`;
if (c.includes('curator') || c.includes('allocator')) return `Deposit $${d} into a ${name} vault on ${chain} and keep the shares.`;
if (c.includes('stable')) return `Mint or deposit $${d} of the stable asset through ${name} on ${chain}.`;
if (c.includes('insurance')) return `Buy $${d} of cover from ${name} on ${chain} and keep the policy.`;
return `Deposit $${d} of USDC into ${name} on ${chain} and keep the position open.`;
}
function weeklyAction(p, verdict) {
const c = (p.category || '').toLowerCase();
const name = p.name;
if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Borrow a small amount against the supply and repay it within the week, so the loan counts as activity.';
if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return "Move the liquidity into the pool's highest-fee range when it drifts.";
if (c.includes('bridge')) return 'Use the bridged funds in the destination app; bridge a small amount back weekly.';
if (c.includes('staking') || c.includes('restak')) return `Restake the receipt through ${name}'s restaking vault when a reward lands.`;
if (c.includes('perpetual') || c.includes('derivative')) return 'Check the funding rate weekly and keep the hedge near delta-neutral.';
if (c.includes('prediction')) return 'Settle the position before the market closes and place the next one.';
if (c.includes('curator') || c.includes('allocator')) return "Rebalance into the vault's newest strategy when it changes.";
if (c.includes('stable')) return 'Hold the minted asset through one full rewards epoch.';
if (c.includes('rwa')) return verdict === 'THIN' ? 'Claim the yield distribution and hold it as cash.' : 'Claim the yield distribution and redeposit it.';
if (c.includes('insurance')) return 'File no claim; renew the cover before it lapses.';
return 'Make one qualifying action, such as a deposit, a borrow, a swap or a vote.';
}
export function stopRuleFor(p) {
const swing = Math.abs(finite(p.change_7d, 10));
const pct = clamp(2 * swing, 10, 35);
const level = Math.max(1, Math.round(p.tvl_usd * (1 - pct / 100)));
return { pct: round2(pct), level };
}
export function flipValueTarget(p, econ) {
const costs = econ.fees + econ.capitalCost;
if (!(p.tvl_usd > 0) || !(econ.deposit > 0) || !(costs > 0)) return null;
return Math.ceil((100 * costs * p.tvl_usd) / econ.deposit);
}
export function flipFeeTarget(p, econ) {
const target = 0.1 * econ.slice - econ.capitalCost;
return target > 0 ? Math.round(target * 100) / 100 : null;
}
export function oddsDisplay(o) {
if (o === null || o === undefined || !Number.isFinite(o)) return 'n/a';
if (o > 1) return '>100%';
return (o * 100).toFixed(1) + '%';
}
function growthClause(p) {
const g = p.change_7d;
if (g === null || g === undefined) return 'TVL has no 7-day figure';
return `TVL moved ${(g >= 0 ? '+' : '') + g.toFixed(1)}% in 7 days`;
}
function poolShare(p, econ) {
if (!(p.tvl_usd > 0)) return 'an unknown share of TVL';
const pct = (econ.deposit / p.tvl_usd) * 100;
if (pct < 0.001) return 'under 0.001% of TVL';
return `${pct.toFixed(3)}% of TVL`;
}
function toSteps(list) {
return list.map(function (s) { return { day: s[0], action: s[1], where: s[2], amount: s[3], cost: s[4], time: s[5], mins: s[6] }; });
}
export function planTotalMinutes(steps) {
return steps.reduce(function (a, s) { return a + (s.mins || 0); }, 0);
}
export function planFor(p, econ, age, implied) {
const chain = econ.chain;
const gas = econ.gasUsd;
const hold = econ.holdDays;
const midway = Math.max(7, Math.round(hold / 2));
const stop = stopRuleFor(p);
const weeklyTime = '15 minutes × ' + (hold / 7).toFixed(1) + ' weeks';
const isFarm = econ.verdict === 'FARM';
// FARM-only Verify/Claim (5 each) move to wallet 5->10, exit 10->15 on THIN.
const walletMins = isFarm ? 5 : 10;
const exitMins = isFarm ? 10 : 15;
const d = econ.deposit.toLocaleString('en-US');
const net = econ.net < 0 ? '−$' + Math.abs(econ.net).toFixed(2) : '$' + econ.net.toFixed(2);
const odds = oddsDisplay(econ.breakEvenOdds);
if (econ.verdict === 'SKIP') {
const target = flipValueTarget(p, econ);
const feeTarget = flipFeeTarget(p, econ);
const minDep = econ.minDeposit === null ? null : econ.minDeposit.toLocaleString('en-US');
const verdictLine = econ.minDeposit === null
? `Verdict: SKIP — expected net ${net} on a $${d} deposit; no deposit size pays at this value.`
: econ.minDeposit > ECON.deposit_max
? `Verdict: SKIP — expected net ${net} on a $${d} deposit; no offered size pays at this value — the smallest paying deposit is $${minDep}, above the $5,000 maximum.`
: `Verdict: SKIP — expected net ${net} on a $${d} deposit, but break-even odds ${odds} exceed the 25% THIN threshold (minimum paying deposit $${minDep}).`;
const now = implied === null || implied === undefined ? '' : ` (now $${implied.toLocaleString('en-US')})`;
return toSteps([
[1, verdictLine, p.name, `$${d} deposit`, '$0.00', '5 minutes', 5],
[1, 'No wallet, no funds: watch only until a flip condition is met.', p.name, '$0', '$0.00', '5 minutes', 5],
[1, target === null ? 'Flip: the numbers give no target value; recheck the inputs.' : `Flip: the implied value would need to reach $${target.toLocaleString('en-US')}${now} for a $${d} deposit to pay at 10% odds.`, p.name, target === null ? '—' : `$${target.toLocaleString('en-US')}`, '$0.00', '10 minutes', 10],
[1, feeTarget === null ? 'Flip: even free transactions would not pay at this value; only a higher implied value flips it.' : `Flip: fees would need to fall to $${feeTarget} (now $${econ.fees.toFixed(2)}) at the current value.`, chain, feeTarget === null ? '—' : `$${feeTarget}`, '$0.00', '10 minutes', 10],
[7, 'Recheck the TVL and the implied value; if either rose, re-run the numbers.', p.name, '—', '$0.00', weeklyTime, (15 * hold) / 7],
[hold, 'Do not deposit: at the current value every dollar in pays less than the fees.', p.name, '$0', '$0.00', '15 minutes', 15],
[hold, 'Log the value, TVL and date; compare on the next check.', p.name, '—', '$0.00', '15 minutes', 15],
]);
}
const isRwa = (p.category || '').toLowerCase().includes('rwa');
const verdictLine = econ.verdict === 'FARM'
? `Verdict: FARM — expected net ${net} on a $${d} deposit, break-even odds ${odds}.`
: `Verdict: THIN — expected net ${net} on a $${d} deposit, break-even odds ${odds}; probe only, one position, no top-ups.`;
const ageNote = age === null || age === undefined ? 'age unknown' : `running ${age} days with no token`;
const probe = econ.verdict === 'THIN' ? ' Probe only: do not add capital.' : '';
const dep = depositAction(p, econ).replace(/of USDC|of the chain's staking asset/, 'of ' + (econ.fundingAsset || "the chain's staking asset"));
const s = [
[1, verdictLine, p.name, `$${d} deposit`, '$0.00', '5 minutes', 5],
[1, 'Open a fresh wallet holding only the funds for this farm; keep the seed phrase offline.', chain, '—', `$${gas} of gas (wallet setup)`, walletMins + ' minutes', walletMins],
[isRwa ? 3 : 1, dep + probe, chain, `$${d} (${poolShare(p, econ)})`, `$${gas} of gas (deposit)`, '15 minutes', 15],
[7, weeklyAction(p, econ.verdict), chain, `$${d} stays in the position`, `$${gas} of gas`, weeklyTime, (15 * hold) / 7],
[midway, `Recheck: ${growthClause(p)}; ${ageNote}; if the move reversed, re-run the numbers before staying.${econ.verdict === 'THIN' ? ' Decide whether to exit or hold; do not add capital.' : ''}`, p.name, `$${d} stays in the position`, '$0.00', '10 minutes', 10],
[hold, `Stop: if TVL falls ${stop.pct}% from entry (below $${stop.level.toLocaleString('en-US')}), unwind the position the same day and keep the log. If the protocol pauses withdrawals, wait and recheck weekly; unwind once they resume. A stop is a plan, not a guarantee.`, chain, `$${d}`, '$0.00', '5 minutes', 5],
[hold, `Withdraw the $${d} and log wallet, dates and every transaction.`, p.name, `$${d}`, `$${gas} of gas to exit`, exitMins + ' minutes', exitMins],
];
if (econ.verdict === 'FARM') { s.splice(2, 0, [1, 'Verify: check contract and audit on the explorer; confirm no token yet (5 min, no transaction).', chain, '—', '$0.00', '5 minutes', 5]); s.splice(7, 0, [hold, 'Claim (only if an airdrop is announced): only via the official site; never sign a message link (5 min; claiming costs gas, not in plan fees).', p.name, '$0', '$0.00', '5 minutes', 5]); }
return toSteps(s);
}
export function farmSteps(p, econ, age, implied) {
return planFor(p, econ, age, implied).map(stepText);
}
function percentile(sorted, p) {
if (sorted.length === 0) return null;
const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
return sorted[idx];
}
export function bandAndRankRange(rows, refits) {
const out = new Map();
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
