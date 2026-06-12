// Refuses to publish unless every declared target has a prebuilt `.node` in
// the package root. The fat package ships all of them; a missing one means a
// CI matrix leg failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// triple → expected .node filename (matches what napi build --platform emits)
const EXPECTED = {
  'universal-apple-darwin': 'index.darwin-universal.node',
  'x86_64-pc-windows-msvc': 'index.win32-x64-msvc.node',
  'aarch64-pc-windows-msvc': 'index.win32-arm64-msvc.node',
  'x86_64-unknown-linux-gnu': 'index.linux-x64-gnu.node',
  'aarch64-unknown-linux-gnu': 'index.linux-arm64-gnu.node',
  'x86_64-unknown-linux-musl': 'index.linux-x64-musl.node',
  'aarch64-unknown-linux-musl': 'index.linux-arm64-musl.node',
  'i686-unknown-linux-gnu': 'index.linux-ia32-gnu.node',
  'armv7-unknown-linux-gnueabihf': 'index.linux-arm-gnueabihf.node',
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const missing = Object.entries(EXPECTED).filter(
  ([, f]) => !fs.existsSync(path.join(dir, f)),
);

if (missing.length) {
  console.error('Refusing to publish — missing prebuilds:');
  for (const [triple, f] of missing) console.error(`  ${triple.padEnd(30)} ${f}`);
  process.exit(1);
}

let total = 0;
for (const f of Object.values(EXPECTED)) {
  const { size } = fs.statSync(path.join(dir, f));
  total += size;
  console.log(`  ${f.padEnd(34)} ${(size / 1024).toFixed(0).padStart(5)} KB`);
}
console.log(`  ${'total'.padEnd(34)} ${(total / 1024).toFixed(0).padStart(5)} KB`);

// Belt-and-braces: the published binding.js must not contain a require() of an
// `@electron-internal/...-<triple>` package — that fallback path is a
// dependency-confusion foothold on platforms we don't ship a prebuild for.
const binding = fs.readFileSync(path.join(dir, 'binding.js'), 'utf8');
if (binding.includes("require('@electron-internal/")) {
  console.error(
    'Refusing to publish — binding.js still contains @electron-internal/* package fallbacks. ' +
      'Run `yarn build` (which runs scripts/strip-binding-fallbacks.js).',
  );
  process.exit(1);
}
