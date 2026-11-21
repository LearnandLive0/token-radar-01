// tools/shoot.mjs — screenshot + gate driver for B'.
//
// Usage:
//   node tools/shoot.mjs --detail <slug> [--shots 1,2,3,4] [--port N] [--keep-png]
//
// Serves out/, drives headless Chrome over CDP, gates the detail shot on the
// live DOM, and writes screenshots/*.png.b64 (256-color palette PNG, base64,
// single line — the same pipeline that produced B's committed shots).
//
// The gate runs BEFORE anything is written: any failure exits non-zero and
// writes no .b64. Visual inspection is not a gate.
//
// Shot URLs (1440x1000, --hide-scrollbars, Chrome 158):
//   1-board    dashboard/index.html
//   2-detail   dashboard/index.html#p=<detail slug>   (strict gate)
//   3-filtered dashboard/index.html#verdict=FARM      (all visible verdicts FARM)
//   4-method   dashboard/index.html#view=method       (method section present)
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDetailDom, checkDetailRow } from './shot-check.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'out');
const SHOTS = join(ROOT, 'screenshots');
const WIDTH = 1440;
const HEIGHT = 1000;

function fail(msg) {
  process.stderr.write('shoot: ' + msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { shots: [1, 2, 3, 4], port: 0, keepPng: false, detail: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--detail') args.detail = argv[++i];
    else if (argv[i] === '--shots') args.shots = argv[++i].split(',').map(Number);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--keep-png') args.keepPng = true;
    else fail('unknown arg: ' + argv[i]);
  }
  if (args.shots.includes(2) && !args.detail) fail('--detail <slug> is required for shot 2');
  return args;
}

// out/ must be freshly built from the current dashboard sources (D24 lesson).
function checkFresh() {
  if (!existsSync(join(OUT, 'board.json'))) {
    fail('out/board.json missing — rebuild out/ first: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot>');
  }
  for (const f of ['index.html', 'app.css', 'app.js', 'model.js']) {
    const src = statSync(join(ROOT, 'dashboard', f)).mtimeMs;
    const built = statSync(join(OUT, 'dashboard', f)).mtimeMs;
    if (src > built) fail('dashboard/' + f + ' is newer than out/dashboard/' + f + ' — rebuild out/ first');
  }
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.js')) return 'text/javascript';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function serve(dir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      const file = join(dir, path === '/' ? 'index.html' : path);
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(file) });
      res.end(readFileSync(file));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status);
  return res.json();
}

// Minimal CDP client over the browser WebSocket (Node 24 has a global WebSocket).
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
    this.ws.onerror = (e) => {
      for (const { reject } of this.pending.values()) reject(new Error('WS error: ' + e.message));
      this.pending.clear();
    };
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async waitForEvent(method, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = this.events.findIndex((e) => e.method === method);
      if (i >= 0) return this.events.splice(i, 1)[0];
      await sleep(50);
    }
    throw new Error('timeout waiting for ' + method);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function launchChrome() {
  const profile = join(tmpdir(), 'bprime-chrome-' + process.pid);
  mkdirSync(profile, { recursive: true });
  const child = spawn('google-chrome', [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });
  // Chrome writes the DevTools port into DevToolsActivePort in the profile dir.
  const portFile = join(profile, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      break;
    }
    if (child.exitCode !== null) fail('chrome exited early with code ' + child.exitCode);
    await sleep(100);
  }
  if (!port) fail('chrome did not write DevToolsActivePort');
  const version = await fetchJson('http://127.0.0.1:' + port + '/json/version');
  return { child, port, wsUrl: version.webSocketDebuggerUrl };
}

const DETAIL_MEASURE = `(() => {
  const dialog = document.querySelector('dialog.detail');
  const verdictEl = dialog ? dialog.querySelector('.verdict') : null;
  const rows = dialog ? dialog.querySelectorAll('table.plan tbody tr') : [];
  let dollar = 0;
  rows.forEach((tr) => {
    const cost = tr.children[4];
    if (cost && cost.textContent.indexOf('$') >= 0) dollar++;
  });
  const table = dialog ? dialog.querySelector('table.plan') : null;
  const rect = table ? table.getBoundingClientRect() : null;
  return {
    dialogOpen: !!(dialog && dialog.open),
    verdict: verdictEl ? verdictEl.textContent.trim() : null,
    stepRows: rows.length,
    dollarCosts: dollar,
    tableBottom: rect ? Math.round(rect.bottom) : null,
    dialogScrollTop: dialog ? dialog.scrollTop : null,
    arithPresent: !!(dialog && dialog.querySelector('.arith')),
  };
})()`;

const BOARD_MEASURE = `(() => {
  const dialog = document.querySelector('dialog.detail');
  const rows = document.querySelectorAll('table tbody tr');
  return {
    dialogOpen: !!(dialog && dialog.open),
    boardRows: rows.length,
  };
})()`;

const FILTERED_MEASURE = `(() => {
  const dialog = document.querySelector('dialog.detail');
  const pills = [...document.querySelectorAll('table tbody tr .verdict')].map((e) => e.textContent.trim());
  return {
    dialogOpen: !!(dialog && dialog.open),
    verdictPills: pills,
    farmPills: pills.filter((v) => v === 'FARM').length,
  };
})()`;

const METHOD_MEASURE = `(() => {
  const dialog = document.querySelector('dialog.detail');
  const heads = [...document.querySelectorAll('h2')].map((h) => h.textContent.trim());
  return {
    dialogOpen: !!(dialog && dialog.open),
    methodPresent: heads.includes('How the model is tested'),
  };
})()`;

function palettePng(srcPng, dstPng) {
  // Same pipeline as B's committed shots: PIL adaptive 256-color palette.
  // Verified: this reproduces B's 1-board.png.b64 pixel-for-pixel (0.0000% diff).
  const script = [
    'import sys',
    'from PIL import Image',
    'src, dst = sys.argv[1], sys.argv[2]',
    'im = Image.open(src).convert("RGB")',
    'pal = im.convert("P", palette=Image.ADAPTIVE, colors=256)',
    'pal.save(dst)',
    'print(pal.size[0], pal.size[1])',
  ].join('\n');
  execFileSync('python3', ['-c', script, srcPng, dstPng], { stdio: 'pipe' });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkFresh();
  const board = JSON.parse(readFileSync(join(OUT, 'board.json'), 'utf8'));
  const rowsBySlug = new Map(board.rows.map((r) => [r.slug, r]));

  // Data-level gate for the detail row, before any browser work.
  if (args.shots.includes(2)) {
    const row = rowsBySlug.get(args.detail);
    const g = checkDetailRow(row);
    if (!g.ok) fail('detail row gate (board.json, slug ' + args.detail + '): ' + g.failures.join('; '));
  }

  const server = await serve(OUT, args.port);
  const httpPort = server.address().port;
  const base = 'http://127.0.0.1:' + httpPort + '/dashboard/index.html';
  const { child, wsUrl } = await launchChrome();
  const cdp = new Cdp(wsUrl);
  let exitCode = 0;
  try {
    await cdp.ready();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // Pin the layout viewport to 1440x1000: --window-size alone leaves the
    // CDP viewport at 913px tall, which would ship 1440x913 screenshots.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    const shots = {
      1: { name: '1-board', url: base, measure: BOARD_MEASURE, check: (m) => {
        if (m.dialogOpen) return 'board shot has a dialog open';
        if (m.boardRows < 1) return 'board table has no rows';
        return null;
      } },
      2: { name: '2-detail', url: base + '#p=' + encodeURIComponent(args.detail), measure: DETAIL_MEASURE, check: (m) => {
        const g = checkDetailDom(m);
        return g.ok ? null : 'detail gate (live DOM): ' + g.failures.join('; ');
      } },
      3: { name: '3-filtered', url: base + '#verdict=FARM', measure: FILTERED_MEASURE, check: (m) => {
        if (m.dialogOpen) return 'filtered shot has a dialog open';
        if (m.verdictPills.length < 1) return 'filtered table shows no verdict pills';
        if (m.farmPills !== m.verdictPills.length) return 'filtered table shows non-FARM verdicts (' + m.farmPills + '/' + m.verdictPills.length + ' FARM)';
        return null;
      } },
      4: { name: '4-method', url: base + '#view=method', measure: METHOD_MEASURE, check: (m) => {
        if (m.dialogOpen) return 'method shot has a dialog open';
        if (!m.methodPresent) return 'method section not present';
        return null;
      } },
    };

    let first = true;
    for (const n of args.shots) {
      const shot = shots[n];
      if (!shot) fail('unknown shot: ' + n);
      // The page reads the hash once at load (readHash, no hashchange
      // listener), so a hash-only navigation would not open the dialog.
      // Force a full document load for every shot via about:blank.
      if (!first) {
        await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId);
        await cdp.waitForEvent('Page.loadEventFired', 15000);
      }
      first = false;
      await cdp.send('Page.navigate', { url: shot.url }, sessionId);
      await cdp.waitForEvent('Page.loadEventFired', 15000);
      await sleep(1200);
      const vpRes = await cdp.send('Runtime.evaluate', {
        expression: '({ w: window.innerWidth, h: window.innerHeight })',
        returnByValue: true,
      }, sessionId);
      const vp = vpRes.result.value;
      if (vp.w !== WIDTH || vp.h !== HEIGHT) {
        fail('shot ' + n + ': viewport is ' + vp.w + 'x' + vp.h + ', not ' + WIDTH + 'x' + HEIGHT);
      }
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: shot.measure,
        returnByValue: true,
      }, sessionId);
      if (evalRes.exceptionDetails) {
        fail('shot ' + n + ' measurement threw: ' + JSON.stringify(evalRes.exceptionDetails));
      }
      const m = evalRes.result.value;
      const problem = shot.check(m);
      if (problem) {
        process.stderr.write('shoot: shot ' + n + ' (' + shot.name + ') FAILED: ' + problem + '\n');
        process.stderr.write('shoot: measurement: ' + JSON.stringify(m) + '\n');
        process.stderr.write('shoot: wrote nothing for this shot\n');
        exitCode = 1;
        continue;
      }
      const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const pngBuf = Buffer.from(shotRes.data, 'base64');
      const rawPng = join(tmpdir(), 'bprime-' + shot.name + '-raw.png');
      const palPng = join(tmpdir(), 'bprime-' + shot.name + '-pal.png');
      writeFileSync(rawPng, pngBuf);
      palettePng(rawPng, palPng);
      const palBuf = readFileSync(palPng);
      const b64 = palBuf.toString('base64');
      const b64Path = join(SHOTS, shot.name + '.png.b64');
      writeFileSync(b64Path, b64);
      // Verify the packaged file decodes to exactly the palette PNG.
      const decoded = Buffer.from(readFileSync(b64Path, 'utf8').replace(/\s+/g, ''), 'base64');
      if (sha256(decoded) !== sha256(palBuf)) fail('shot ' + n + ': packaged .b64 does not decode to the palette PNG');
      if (!args.keepPng) {
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(rawPng);
          unlinkSync(palPng);
        } catch {
          /* best effort */
        }
      }
      process.stdout.write('shoot: shot ' + n + ' (' + shot.name + ') OK -> ' + b64Path + ' (' + b64.length + ' B, png sha ' + sha256(palBuf).slice(0, 12) + ')\n');
    }
  } finally {
    cdp.close();
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    server.close();
  }
  process.exit(exitCode);
}

main().catch((e) => fail(e.message));
