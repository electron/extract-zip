// Quick benchmark: this package vs the original `extract-zip`.
//
//   node bench/bench.js
//
// Builds three corpora, zips them with the system `zip`, then times N
// extractions of each with both implementations.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import native from '../index.js';
import original from 'extract-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-bench-'));
const ITERS = 5;

function rnd(n) { return crypto.randomBytes(n); }
function txt(n) { return Buffer.alloc(n, 'lorem ipsum dolor sit amet ').toString(); }

function buildCorpus(name, populate) {
  const src = path.join(ROOT, name, 'src');
  fs.mkdirSync(src, { recursive: true });
  populate(src);
  const zip = path.join(ROOT, name + '.zip');
  execFileSync('zip', ['-rq', zip, '.'], { cwd: src });
  const { size } = fs.statSync(zip);
  return { name, zip, size };
}

async function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

async function run(label, zip, impl) {
  const out = path.join(ROOT, 'out-' + label);
  // Warm-up
  fs.rmSync(out, { recursive: true, force: true });
  await impl(zip, { dir: out });

  const times = [];
  for (let i = 0; i < ITERS; i++) {
    fs.rmSync(out, { recursive: true, force: true });
    times.push(await timeIt(() => impl(zip, { dir: out })));
  }
  times.sort((a, b) => a - b);
  return { mean: times.reduce((a, b) => a + b) / times.length, p50: times[times.length >> 1] };
}

(async () => {
  console.log(`node ${process.version}  ${process.platform}/${process.arch}  iters=${ITERS}\n`);

  const corpora = [
    buildCorpus('many-small', (dir) => {
      // 2000 small text files across 40 dirs — stresses per-entry overhead
      for (let d = 0; d < 40; d++) {
        const sub = path.join(dir, 'd' + d);
        fs.mkdirSync(sub);
        for (let f = 0; f < 50; f++) {
          fs.writeFileSync(path.join(sub, `f${f}.txt`), txt(256 + (f % 7) * 128));
        }
      }
    }),
    buildCorpus('few-large', (dir) => {
      // 8 × 4 MB compressible blobs — stresses inflate throughput
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(path.join(dir, `blob${i}.bin`), txt(4 * 1024 * 1024));
      }
    }),
    buildCorpus('mixed-binary', (dir) => {
      // 200 random (incompressible) files of mixed sizes — stresses I/O
      for (let i = 0; i < 200; i++) {
        fs.writeFileSync(path.join(dir, `r${i}.bin`), rnd(8 * 1024 + (i % 13) * 4096));
      }
    }),
    // Real-world: this repo's node_modules (typical "download & unpack" case)
    (() => {
      const zip = path.join(ROOT, 'node_modules.zip');
      execFileSync('zip', ['-rq', zip, '.'], { cwd: path.join(__dirname, '..', 'node_modules') });
      return { name: 'node_modules', zip, size: fs.statSync(zip).size };
    })(),
  ];

  console.log('corpus          zip size   extract-zip(js)   @electron(native)   speedup');
  console.log('─'.repeat(78));
  for (const c of corpora) {
    const js = await run('js-' + c.name, c.zip, original);
    const nv = await run('nv-' + c.name, c.zip, native);
    const speedup = (js.p50 / nv.p50).toFixed(1) + '×';
    console.log(
      c.name.padEnd(15),
      (c.size / 1024 / 1024).toFixed(1).padStart(6) + ' MB ',
      (js.p50.toFixed(1) + ' ms').padStart(14) + '  ',
      (nv.p50.toFixed(1) + ' ms').padStart(16) + '  ',
      speedup.padStart(7),
    );
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
})();
