# @electron-internal/extract-zip

Fast, safe, native zip extraction for Node.js. Drop-in replacement for [`extract-zip`](https://github.com/max-mapper/extract-zip).

- **Native** — Rust core via N-API. Decompression runs off the event loop on a worker thread.
- **Fast** — ~2× faster on entry-heavy archives; never slower. See [benchmarks](#benchmarks).
- **Safe** — hardened against Zip Slip, symlink escapes, absolute paths, NUL injection, Windows reserved names, and zip bombs.
- **Zero runtime deps** — no `debug`/`yauzl`/`get-stream` in your tree.
- **Cross-platform** — prebuilt binaries for macOS (x64/arm64), Linux (glibc/musl, x64/arm64), Windows (x64/arm64).
- **Compatible** — supports Store and Deflate entries (the only methods Electron release zips use).

## Install

```sh
yarn add @electron-internal/extract-zip
```

## Usage

ESM only:

```js
import extract from '@electron-internal/extract-zip';

await extract('archive.zip', { dir: '/absolute/output/path' });
```

### Options

`dir` (required, absolute path) is the only option.

Behaviour is fixed to sensible defaults: existing files are overwritten, Unix
permission bits (`0o777` mask — setuid/setgid/sticky are stripped) and mtimes
from the archive are preserved, symlinks are materialised (skipped silently on
Windows without symlink privilege), and file writes are parallelised across
`min(cpus, 8)` workers. `onEntry`, `defaultDirMode` and `defaultFileMode` from
the original `extract-zip` are not supported — a survey of every consumer in
the `electron` org found zero callers of any option but `dir`.

## Security

Every entry path is normalised and verified to land inside `dir`:

- `..` traversal is rejected and absolute paths are stripped via the `zip` crate's audited `enclosed_name()` (Zip Slip / [Snyk research](https://security.snyk.io/research/zip-slip-vulnerability)).
- Directories are created component-by-component without following symlinks; an entry whose path crosses a symlink (pre-existing or from the archive) is rejected.
- Symlinks are created **after** all files. Each target is walked component-by-component against the on-disk tree *and* the archive's own symlink set: every hop is relative, every `..` is bounded by `dir`, and the hop count is capped — so `Versions/Current/Libraries` works, but a chain that would resolve outside `dir` is rejected before any link is created.
- NUL bytes and Windows reserved device names (`CON`, `AUX`, `COM¹`, trailing space/dot…) are rejected on every platform.
- Symlink target strings are capped at 4 KiB; per-file output is capped at `max(2 × declared size, 1 MB)` to catch entries that lie about their uncompressed size.

`test/security.test.js` exercises the symlink-chain / symlink-swap escape class
end-to-end with hand-crafted archives.

## Benchmarks

`yarn bench` (Apple M-series, Node 24, median of 5):

| Corpus | Zip size | `extract-zip` (JS) | this (serial) | this (parallel) |
|---|--:|--:|--:|--:|
| **electron-v42.2.0-darwin-arm64** | 112 MB | 817 ms | 614 ms | **441 ms · 1.9×** |
| 8 × 4 MB compressible | 0.1 MB | 24 ms | — | **3 ms · 9.4×** |
| 2000 small text files | 0.4 MB | 372 ms | — | **199 ms · 1.9×** |
| 200 incompressible files | 6.2 MB | 40 ms | — | **22 ms · 1.8×** |
| `node_modules` | 2.9 MB | 68 ms | — | **37 ms · 1.9×** |

Extraction is four-phase: a serial pass validates paths and creates directories
(never following symlinks), a worker pool inflates and writes regular files
concurrently with zlib-ng, then symlinks and finally directory metadata are
applied serially. The Electron
zip's wall-clock is gated by its single 182 MB `Electron Framework` binary;
that file alone is ~440 ms of inflate+write that can't be split further.

## Distribution

One package ships all prebuilt binaries (~2 MB gzipped):

| | |
|---|---|
| macOS | `darwin-universal` (x64 + arm64 lipo'd) |
| Windows | `win32-x64-msvc`, `win32-arm64-msvc` |
| Linux glibc | `linux-x64-gnu`, `linux-arm64-gnu` |
| Linux musl (Alpine) | `linux-x64-musl`, `linux-arm64-musl` |

`binding.js` picks the right one at load time. No `optionalDependencies`,
no postinstall, no network at install.

## Building from source

Requires a Rust toolchain (and `cmake` for zlib-ng).

```sh
yarn install
yarn build     # builds index.<your-platform>.node
yarn test
```

### Releasing

Push a `v*` tag. `.github/workflows/release.yml` fans out to 7 build jobs,
collects the `.node` artifacts, runs `scripts/check-prebuilds.js` (refuses to
publish if any target is missing), then `yarn npm publish --provenance`.

## License

BSD-2-Clause
