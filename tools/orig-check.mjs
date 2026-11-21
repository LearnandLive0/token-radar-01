// tools/orig-check.mjs — originality scan, B's method (see b-report.md).
// Compares dashboard source lines vs P01 (research/nightshift-*) and P03
// (research/oktamind-*). Gross overlap counts every shared line; the honest
// measure is distinctive lines only: our lines NOT in the kit starter
// (token-radar-01-kit/starter), as a share of all distinctive lines. The
// <3% bar applies to the distinctive figure. Run: node tools/orig-check.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = join(root, '..', 'token-radar-01-kit');
const research = join(root, '..', 'research');
function filesUnder(dir, pred) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, pred));
    else if (!pred || pred(name)) out.push(p);
  }
  return out;
}
function lines(paths) {
  const s = new Set();
  for (const p of paths) {
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      const t = l.replace(/\s+$/, '');
      if (t.length > 0) s.add(t);
    }
  }
  return s;
}
const ours = lines(['model.js', 'app.js', 'app.css', 'index.html'].map((f) => join(root, 'dashboard', f)));
const starter = lines(filesUnder(join(kit, 'starter')));
const p01 = lines(filesUnder(research, (n) => n.startsWith('nightshift')));
const p03 = lines(filesUnder(research, (n) => n.startsWith('oktamind')));
const inter = (a, b) => [...a].filter((x) => b.has(x));
const distinct = new Set([...ours].filter((x) => !starter.has(x)));
function report(label, other) {
  const gross = inter(ours, other);
  const dmatch = inter(distinct, other);
  console.log(`${label}: gross ${gross.length}/${ours.size} = ${(100 * gross.length / ours.size).toFixed(2)}%; distinctive ${dmatch.length}/${distinct.size} = ${(100 * dmatch.length / distinct.size).toFixed(2)}% ${dmatch.length / distinct.size < 0.03 ? 'PASS' : 'FAIL'}`);
  for (const l of dmatch) console.log(`  distinctive match: ${l}`);
  return { gross: gross.length, grossPct: 100 * gross.length / ours.size, distinctive: dmatch.length, distinctivePct: 100 * dmatch.length / distinct.size };
}
console.log(`ours: ${ours.size} lines; starter: ${starter.size} lines; distinctive: ${distinct.size} lines`);
const r01 = report('P01 nightshift', p01);
const r03 = report('P03 oktamind', p03);
