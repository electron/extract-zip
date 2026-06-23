// `napi build --js binding.js` emits a loader that falls back to
// `require('@electron-internal/extract-zip-<triple>')` when the bundled
// `./index.<triple>.node` file is missing. We ship every supported triple in
// one fat package, so the only time the fallback fires is on an *unsupported*
// triple — at which point requiring an unscoped-by-us package is a
// dependency-confusion foothold. Strip those branches; an unsupported triple
// should hard-fail instead.
//
// Strategy: rewrite each `require('@electron-internal/…')` line into a `throw`.
// This keeps the try/catch structure intact (the throw is caught and pushed to
// `loadErrors`, then surfaced by the existing aggregation), so the user still
// gets a helpful error.
//
// On top of that, we inject a musl fallback into the linux gnu (glibc) arch
// branches. The generated loader picks gnu vs musl purely by libc *family*
// (`isMusl()`), with no glibc-version check. On a glibc host whose system glibc
// is older than what our gnu prebuild was linked against, requiring
// `./index.linux-<arch>-gnu.node` throws (e.g. `GLIBC_2.33 not found`) and the
// loader gives up — even though we also bundle a statically-linked musl binary
// that runs fine on glibc hosts. So after the gnu `.node` require fails we also
// try the bundled `./index.linux-<arch>-musl.node` before giving up. This is a
// defense-in-depth safety net: it can only ever turn a hard install failure
// into a working load, and never changes behaviour when the gnu binary loads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dirname, '..', 'binding.js');
let src = fs.readFileSync(file, 'utf8');

// --- Step 1: inject the gnu -> musl fallback for the 64-bit linux arches -----
//
// We target the gnu `.node` require together with the `catch` that pushes the
// failure to `loadErrors`, and rewrite the catch so that — after recording the
// gnu failure — it also attempts the bundled musl binary. The musl require is
// wrapped in its own try/catch that pushes to `loadErrors` on failure, matching
// the existing generated style.
const MUSL_FALLBACK_ARCHES = ['x64', 'arm64'];
for (const arch of MUSL_FALLBACK_ARCHES) {
  const sentinel = `return require('./index.linux-${arch}-musl.node')`;
  // The gnu require + its catch, captured so we can preserve the generator's
  // exact indentation when we rewrite it.
  const re = new RegExp(
    `(?<ind>[ \\t]*)return require\\('\\.\\/index\\.linux-${arch}-gnu\\.node'\\)\\r?\\n` +
      `(?<cind>[ \\t]*)\\} catch \\(e\\) \\{\\r?\\n` +
      `(?<bind>[ \\t]*)loadErrors\\.push\\(e\\)\\r?\\n` +
      `(?<eind>[ \\t]*)\\}`,
  );
  const before = src;
  src = src.replace(re, (match, ind, cind, bind, eind) => {
    // ind   = indentation of the `return require(...)` line
    // cind  = indentation of the `} catch (e) {` line
    // bind  = indentation of the `loadErrors.push(e)` line
    // eind  = indentation of the closing `}`
    return (
      `${ind}return require('./index.linux-${arch}-gnu.node')\n` +
      `${cind}} catch (e) {\n` +
      `${bind}loadErrors.push(e)\n` +
      // The bundled musl binary is statically linked, so it runs on glibc
      // hosts too. Fall back to it when the gnu prebuild fails to load.
      `${bind}try {\n` +
      `${bind}  return require('./index.linux-${arch}-musl.node')\n` +
      `${bind}} catch (e) {\n` +
      `${bind}  loadErrors.push(e)\n` +
      `${bind}}\n` +
      `${eind}}`
    );
  });
  if (src === before) {
    console.error(
      `strip-binding-fallbacks: could not inject musl fallback for ${arch} — generator output changed?`,
    );
    process.exit(1);
  }
  if (!src.includes(sentinel)) {
    console.error(
      `strip-binding-fallbacks: musl fallback for ${arch} missing after rewrite — refusing to write`,
    );
    process.exit(1);
  }
}

// --- Step 2: strip the @electron-internal/* package fallbacks ----------------
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
}

fs.writeFileSync(file, src);
console.log('strip-binding-fallbacks: removed package-name fallbacks and added musl fallback to binding.js');
