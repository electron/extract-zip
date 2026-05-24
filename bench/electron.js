// Benchmarks the latest Electron macOS release zip.
// Download once with:
//   curl -L -o bench/.cache/electron-<ver>-darwin-arm64.zip <url>
// then:  node bench/electron.js [path-to-zip]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import native from '../index.js';
import original from 'extract-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ZIP = process.argv[2] ||
  path.join(__dirname, '.cache', fs.readdirSync(path.join(__dirname, '.cache'))
    .find((f) => /^electron-.*-darwin-.*\.zip$/.test(f)));

if (!ZIP || !fs.existsSync(ZIP)) {
  console.error('electron release zip not found; pass a path or place one in bench/.cache/');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-electron-'));
const ITERS = 3;

async function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function bench(label, impl, opts = {}) {
  const out = path.join(ROOT, label);
  // warm-up
  fs.rmSync(out, { recursive: true, force: true });
  await impl(ZIP, { dir: out, ...opts });
  const times = [];
  for (let i = 0; i < ITERS; i++) {
    fs.rmSync(out, { recursive: true, force: true });
    times.push(await timeIt(() => impl(ZIP, { dir: out, ...opts })));
  }
  times.sort((a, b) => a - b);
  return { p50: times[times.length >> 1], min: times[0], out };
}

function verifyFramework(dir) {
  // Electron.app/Contents/Frameworks/Electron Framework.framework uses the
  // standard Versions/Current -> A symlink layout. Check it survived.
  const fw = path.join(dir, 'Electron.app', 'Contents', 'Frameworks',
    'Electron Framework.framework');
  const current = path.join(fw, 'Versions', 'Current');
  const top = path.join(fw, 'Electron Framework');
  return {
    currentIsLink: fs.lstatSync(current).isSymbolicLink(),
    currentTarget: fs.readlinkSync(current),
    topIsLink: fs.lstatSync(top).isSymbolicLink(),
    binSize: fs.statSync(path.join(fw, 'Versions', 'A', 'Electron Framework')).size,
  };
}

(async () => {
  const { size } = fs.statSync(ZIP);
  console.log(`${path.basename(ZIP)}  ${(size / 1024 / 1024).toFixed(1)} MB  iters=${ITERS}\n`);

  const js = await bench('js', original);
  const nv = await bench('nv', native);

  console.log('impl                       p50         min     speedup');
  console.log('─'.repeat(56));
  const row = (l, r, base) =>
    console.log(l.padEnd(22), (r.p50.toFixed(0) + ' ms').padStart(9),
      (r.min.toFixed(0) + ' ms').padStart(10), '   ',
      base ? (base.p50 / r.p50).toFixed(2) + '×' : '1.00×');
  row('extract-zip (js)', js);
  row('native', nv, js);

  console.log('\nframework symlinks:');
  console.log('  js    ', verifyFramework(js.out));
  console.log('  native', verifyFramework(nv.out));

  // Structural diff (file list + sizes) — content diff would take too long.
  const ls = (d) => execFileSync('find', [d, '-type', 'f', '-exec', 'stat', '-f', '%z %N', '{}', ';'])
    .toString().replaceAll(d, '').split('\n').sort().join('\n');
  console.log('\noutput trees identical:', ls(js.out) === ls(nv.out));

  fs.rmSync(ROOT, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
