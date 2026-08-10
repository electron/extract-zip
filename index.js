import path from 'node:path';

let enginePromise = null;

// The native binding is loaded lazily, on the first extract() call. When it
// does not load — for example, an OS code-integrity policy refuses to dlopen
// the prebuilt .node file (electron/electron#52481) — extraction falls back
// to the pure-JavaScript engine in js-fallback.js, with a warning that
// carries the real load error. Set EXTRACT_ZIP_FORCE_JS=1 to force the
// JavaScript engine (used by the fallback parity tests).
async function loadEngine() {
  if (!process.env.EXTRACT_ZIP_FORCE_JS) {
    try {
      const { extract: nativeExtract } = await import('./binding.js');
      return (zipPath, opts) => nativeExtract(zipPath, opts);
    } catch (err) {
      process.emitWarning(
        '@electron-internal/extract-zip: the native binding did not load; ' +
          `using the slower JavaScript extractor. Cause: ${err.message}`,
      );
    }
  }
  const { extractJs } = await import('./js-fallback.js');
  return (zipPath, opts) => extractJs(zipPath, opts.dir);
}

/**
 * Extract a zip archive to a directory.
 *
 *   await extract(source, { dir: '/abs/path' })
 *
 * @param {string} zipPath
 * @param {import('./index.js').ExtractOptions} opts
 * @returns {Promise<void>}
 */
export async function extract(zipPath, opts) {
  if (!opts || typeof opts.dir !== 'string') {
    throw new TypeError('extract: opts.dir is required');
  }
  if (!path.isAbsolute(opts.dir)) {
    throw new TypeError('extract: opts.dir must be an absolute path');
  }
  enginePromise ??= loadEngine();
  return (await enginePromise)(zipPath, opts);
}

export default extract;
