// Post-process the napi-generated `binding.js` loader before it ships. Two
// independent fix-ups, both guarded so they fail loudly if napi's generated
// output ever changes shape:
//
// 1) Strip @electron-internal/* package fallbacks.
//    `napi build --js binding.js` emits a loader that falls back to
//    `require('@electron-internal/extract-zip-<triple>')` when the bundled
//    `./index.<triple>.node` file is missing. We ship every supported triple in
//    one fat package, so the only time the fallback fires is on an *unsupported*
//    triple — at which point requiring an unscoped-by-us package is a
//    dependency-confusion foothold. Rewrite each such `require(...)` into a
//    `throw` (still caught and surfaced by the existing aggregation), so an
//    unsupported triple hard-fails with a helpful error instead.
//
// 2) Add the missing 32-bit x86 Linux branch.
//    napi's loader template has no `process.arch === 'ia32'` case under Linux
//    (it covers x64/arm64/arm/loong64/riscv64/ppc64/s390x only), so the
//    index.linux-ia32-gnu.node prebuild we ship would otherwise be unreachable
//    and 32-bit Linux would hit "Unsupported architecture on Linux". Splice in
//    the branch (gnu only — we don't build a 32-bit musl prebuild).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dirname, '..', 'binding.js');
let src = fs.readFileSync(file, 'utf8');

// ── 2) Inject the linux/ia32 branch ───────────────────────────────────────
const ia32Marker = "require('./index.linux-ia32-gnu.node')";
if (src.includes(ia32Marker)) {
  console.log('strip-binding-fallbacks: linux/ia32 branch already present');
} else {
  // Anchor on the Linux-specific "unsupported arch" else; insert before it.
  const anchor =
    '    } else {\n      loadErrors.push(new Error(`Unsupported architecture on Linux:';
  if (!src.includes(anchor)) {
    console.error('strip-binding-fallbacks: linux unsupported-arch anchor not found — generator output changed?');
    process.exit(1);
  }
  const ia32Branch =
    "    } else if (process.arch === 'ia32') {\n" +
    '      try {\n' +
    `        return ${ia32Marker}\n` +
    '      } catch (e) {\n' +
    '        loadErrors.push(e)\n' +
    '      }\n';
  src = src.replace(anchor, ia32Branch + anchor);
  console.log('strip-binding-fallbacks: added linux/ia32 branch to binding.js');
}

// ── 1) Strip @electron-internal/* package fallbacks ────────────────────────
const sentinel = "require('@electron-internal/";
if (!src.includes(sentinel)) {
  console.log('strip-binding-fallbacks: no package fallbacks found (already stripped)');
} else {
  const before = src;
  src = src.replace(
    /require\('(@electron-internal\/[^']+)'\)/g,
    (_, pkg) =>
      `(() => { throw new Error('prebuild for this platform is not bundled (and ${pkg} is intentionally not published)') })()`,
  );

  if (src === before) {
    console.error('strip-binding-fallbacks: pattern matched nothing — generator output changed?');
    process.exit(1);
  }
  if (src.includes(sentinel)) {
    console.error('strip-binding-fallbacks: leftover @electron-internal require — refusing to write');
    process.exit(1);
  }
  console.log('strip-binding-fallbacks: removed package-name fallbacks from binding.js');
}

fs.writeFileSync(file, src);
