// The napi-generated loader collects every load failure in `loadErrors` and
// then reports one fixed message: "Cannot find native binding. npm has a bug
// related to optional dependencies…". That advice is correct only when the
// prebuild file is missing. When the file exists but `process.dlopen` fails —
// for example, Windows Smart App Control refuses to load the unsigned
// binding (electron/electron#52481) — the message points users at an npm bug
// that is not the cause, and the reinstall it recommends destroys the
// evidence.
//
// Strategy: insert a check at the top of the aggregation block. A load error
// that carries an error code other than "module not found" means the file was
// found but could not be loaded; rethrow that error unchanged. The synthetic
// "prebuild for this platform is not bundled" errors from
// strip-binding-fallbacks.js carry no code, so a genuinely missing prebuild
// still gets the original aggregate message.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dirname, '..', 'binding.js');
let src = fs.readFileSync(file, 'utf8');

const marker = '__propagated_binding_load_error__';
if (src.includes(marker)) {
  console.log('propagate-binding-load-errors: already applied');
  process.exit(0);
}

const anchor = 'if (loadErrors.length > 0) {';
if (!src.includes(anchor)) {
  console.error('propagate-binding-load-errors: aggregation block not found — generator output changed?');
  process.exit(1);
}

const inserted = `${anchor}
    // ${marker}: an error code other than "module not found" means the
    // bundled prebuild exists but could not be loaded (for example, an OS
    // code-integrity policy blocked dlopen). Report that error directly:
    // the generic advice below does not apply and hides the real cause.
    const notFoundCodes = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']
    const loadFailure = loadErrors.find((e) => e && e.code && !notFoundCodes.includes(e.code))
    if (loadFailure) {
      throw loadFailure
    }`;

src = src.replace(anchor, inserted);

if (!src.includes(marker)) {
  console.error('propagate-binding-load-errors: rewrite did not apply — refusing to write');
  process.exit(1);
}

fs.writeFileSync(file, src);
console.log('propagate-binding-load-errors: real load failures now surface directly');
