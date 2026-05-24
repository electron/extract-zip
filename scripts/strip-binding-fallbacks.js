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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dirname, '..', 'binding.js');
let src = fs.readFileSync(file, 'utf8');

const sentinel = "require('@electron-internal/";
if (!src.includes(sentinel)) {
  console.log('strip-binding-fallbacks: no package fallbacks found (already stripped)');
  process.exit(0);
}

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

fs.writeFileSync(file, src);
console.log('strip-binding-fallbacks: removed package-name fallbacks from binding.js');
