// The board's assembly for radar-3: the snapshot in, the ranked board and the dashboard's
// dataset out. This runs only under Node (main.ts imports it); it is not part of the
// dashboard's 65,536-byte source cap. The arithmetic it assembles lives in dashboard/model.js,
// the one file both main.ts and the page run, so the page re-derives every row from the same
// inputs. The validation that proves the model lives in lib/validate.ts.

import {
  ECON,
  MODEL_VERSION,
  TILTS,
  SnapshotError,
  curveValue,
  farmEcon,
  farmSteps,
  fitCurve,
  fitPoints,
  impliedValue,
  isPreToken,
  setAsideReason,
  tradedStems,
} from '../dashboard/model.js';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export function parseSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c) => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist };
}

// ---------------------------------------------------------------- the board

/** The protocols the board ranks, strongest first, with ranks 1..n, plus the named set-aside list. */
export function buildBoard(snapshot, fit) {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  const stems = tradedStems(snapshot);
  const chosen = new Map();
  // The watchlist is the floor: every slug, even one the universe rules would set aside.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Every other pre-token protocol the universe rules allow, above the floor or below it.
  // One that is not ranked is named in the set-aside list with its reason, never dropped silently.
  const setAside = [];
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (!isPreToken(p)) continue;
    const reason = setAsideReason(p, stems);
    if (reason !== null) {
      setAside.push({ slug: p.slug, name: p.name, reason, tvl_usd: p.tvl_usd });
      continue;
    }
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit);
    const econ = farmEcon(p, v.implied, v.age);
    return { p, v, econ };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    curve_value_usd: s.v.curve,
    above_floor: s.p.tvl_usd >= snapshot.floor_usd && !watchlist.has(s.p.slug),
    model: {
      fit_a: fit.a,
      fit_b: fit.b,
      fit_n: fit.n,
      growth_pct: s.v.growthPct,
      growth_multiplier: s.v.growthMult,
      maturity_multiplier: s.v.maturityMult,
      age_days: s.v.age,
    },
    econ: s.econ,
    verdict: s.econ.verdict,
    band_lo_usd: null,
    band_hi_usd: null,
    rank_lo: null,
    rank_hi: null,
    farm_steps: farmSteps(s.p, s.econ, s.v.age),
  }));
  return { rows, setAside };
}

/** The live-token protocols, by market cap, with the curve's price for each: the anchors the board is judged against. */
export function liveRows(snapshot, fit) {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      curve_value_usd: Math.round(curveValue(p.tvl_usd, fit)),
      multiple: p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row) {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    curve_value_usd: row.curve_value_usd,
    above_floor: row.above_floor,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    econ: row.econ,
    verdict: row.verdict,
    band_lo_usd: row.band_lo_usd,
    band_hi_usd: row.band_hi_usd,
    rank_lo: row.rank_lo,
    rank_hi: row.rank_hi,
  };
}

/** Everything the dashboard renders, from the snapshot. Validation and refits are filled in by main.ts. */
export function buildRadar(snapshot) {
  const fit = fitCurve(snapshot);
  const { rows, setAside } = buildBoard(snapshot, fit);
  const live = liveRows(snapshot, fit);
  const byReason = {};
  for (const s of setAside) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  const recordedWithToken = snapshot.protocols.filter((p) => !isPreToken(p) && (p.mcap_usd === null || p.mcap_usd <= 0)).length;
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const early = rows.filter((r) => !snapshot.watchlist.includes(r.slug) && r.tvl_usd < snapshot.floor_usd).length;
  const radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      fit_a: fit.a,
      fit_b: fit.b,
      fit_n: fit.n,
      fit_r2: round4(fit.r2),
      growth_floor: TILTS.growth_floor,
      growth_cap: TILTS.growth_cap,
      growth_half: TILTS.growth_half,
      maturity_young_days: TILTS.maturity_young_days,
      maturity_young: TILTS.maturity_young,
      maturity_mid: TILTS.maturity_mid,
      maturity_full: TILTS.maturity_full,
      maturity_days: TILTS.maturity_days,
      unknown_age_days: TILTS.unknown_age_days,
      t_bill: ECON.t_bill,
      airdrop_share: ECON.airdrop_share,
    },
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: early,
    live_size: live.length,
    universe: {
      ranked: rows.length,
      set_aside: setAside.length,
      set_aside_by_reason: byReason,
      recorded_with_token: recordedWithToken,
      traded,
    },
    set_aside: setAside,
    rows: rows.map(radarRow),
    live,
    // The fit's points, for the Method view's scatter: log TVL against log market cap.
    fit_points: fitPoints(snapshot).map((pt) => ({ x: round4(pt.x), y: round4(pt.y) })),
    validation: null,
    refits: null,
  };
  return { board: rows, radar, fit };
}

// ---------------------------------------------------------------- the gate

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, verdicts, bands, and farm steps. */
export function boardIssue(board, snapshot) {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0].implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.verdict !== 'FARM' && r.verdict !== 'THIN' && r.verdict !== 'SKIP') return `${r.slug} has no farm verdict`;
    if (!Number.isSafeInteger(r.band_lo_usd) || !Number.isSafeInteger(r.band_hi_usd) || r.band_lo_usd <= 0 || r.band_hi_usd < r.band_lo_usd) {
      return `${r.slug} has no uncertainty band`;
    }
    if (!Number.isSafeInteger(r.rank_lo) || !Number.isSafeInteger(r.rank_hi) || r.rank_lo < 1 || r.rank_hi > board.length || r.rank_hi < r.rank_lo) {
      return `${r.slug} has no rank range`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar) {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
