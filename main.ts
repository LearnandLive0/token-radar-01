// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits
// the value curve on the snapshot's traded tokens with the model in dashboard/model.js, writes
// the ranked board to /output/board.json, and copies this repository's dashboard/ and
// screenshots/ to /output. Screenshots are stored in the repository as base64 text (*.b64) and
// decoded into /output/screenshots at run time, because the push path GitHub offers this entry
// carries text only. Last, it writes /output/dossier.json, the summary the judge reads, with
// the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html,
// dashboard/app.css, dashboard/app.js and dashboard/model.js read /output/data.js, which this
// program writes from the same board. The model is one file both places run: main.ts imports
// it, the page loads it as a module and re-derives every row, so the page's numbers and the
// board's numbers are the same arithmetic. radar-3: a runtime-fitted log-log curve, an
// out-of-sample Method view, and every farm plan netted to a verdict in dollars.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandAndRankRange } from './dashboard/model.js';
import { boardIssue, buildRadar, dataScript, parseSnapshot, radarRow } from './lib/board.ts';
import { bootstrapRefits, looCheck, timeSplitCheck } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, fit } = buildRadar(snapshot);

// Validation and bands, computed here and shipped in data.js for the Method view: the
// leave-one-out table and the time split prove the curve out of sample, and the bootstrap
// refits give every row its uncertainty band and rank range.
const refits = bootstrapRefits(snapshot);
const bands = bandAndRankRange(board, refits);
for (const row of board) {
  const b = bands.get(row.slug)!;
  row.band_lo_usd = b.band_lo_usd;
  row.band_hi_usd = b.band_hi_usd;
  row.rank_lo = b.rank_lo;
  row.rank_hi = b.rank_hi;
}
radar.refits = refits;
radar.validation = { loo: looCheck(snapshot), time_split: timeSplitCheck(snapshot) };
radar.rows = board.map(radarRow);

const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// Screenshots ride in the repository as base64 text (*.b64): the push path GitHub offers this
// entry is text-only, so no PNG bytes travel in the repo. Decode each one into /output/screenshots
// under its plain name; the bytes are exactly the PNGs the dashboard was screenshotted from.
const shotFiles = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
const shots: string[] = [];
for (const name of shotFiles) {
  if (name.endsWith('.b64')) {
    const target = name.slice(0, -4);
    const png = Buffer.from(readFileSync(join(out, 'screenshots', name), 'utf8').replace(/\s+/g, ''), 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      process.stderr.write(`token radar: screenshots/${name}: not a PNG once decoded\n`);
      process.exit(1);
    }
    writeFileSync(join(out, 'screenshots', target), png);
    unlinkSync(join(out, 'screenshots', name));
    shots.push(target);
  } else {
    shots.push(name);
  }
}
if (shots.length < 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 4, the board, a detail view, a filtered view and the method view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const looFull = radar.validation.loo.find((r: { variant: string }) => r.variant === 'curve+growth+maturity');
const looFlat = radar.validation.loo.find((r: { variant: string }) => r.variant === 'flat');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside, ${radar.universe.set_aside} set aside)\n` +
    `token radar: curve log10(mcap) = ${fit.a.toFixed(2)} + ${fit.b.toFixed(3)} x log10(TVL/$100M), n=${fit.n}, R2=${fit.r2.toFixed(3)}; LOO median miss ${looFull.median_miss}x vs flat ${looFlat.median_miss}x\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (4 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
