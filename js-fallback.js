// Pure-JavaScript extraction engine, used only when the native binding does
// not load (see index.js). It ports the containment rules of src/lib.rs:
// four passes, `..`-normalisation, no traversal through symlinks, pending-
// link-map verification with case-fold + NFC keys, zip-bomb limits, mode
// masking, and Windows reserved-name rejection. The full extract + security
// test suites run against this engine in CI (test/fallback-parity.test.js),
// so its behavior stays aligned with the native engine.
//
// Error message text mirrors src/lib.rs so callers and tests match both
// engines with the same patterns.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_FILE_MODE = 0o644;
const MODE_MASK = 0o777;
const MAX_SYMLINK_TARGET = 4096;
const MAX_SYMLINK_HOPS = 40;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const isWindows = process.platform === 'win32';

class ZipError extends Error {}
const zerr = (msg) => new ZipError(msg);

// ── central directory parsing ───────────────────────────────────────────────

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readEntries(buf, zipPath) {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw zerr(`failed to read archive '${zipPath}': end of central directory not found`);
  }
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Minimal ZIP64: when the classic fields saturate, read the ZIP64 EOCD.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
      if (buf.readUInt32LE(z64) !== 0x06064b50) {
        throw zerr(`failed to read archive '${zipPath}': bad ZIP64 end of central directory`);
      }
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw zerr(`failed to read archive '${zipPath}': bad central directory entry ${i}`);
    }
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Per-entry ZIP64 extra field for saturated size/offset values.
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let f = e + 4;
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(f)); f += 8; }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(f)); f += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(f)); f += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    // Unix mode bits live in the high 16 bits, but only when the entry was
    // made by a Unix host (3); a DOS-made entry gets the defaults.
    const unixMode = versionMadeBy >>> 8 === 3 ? externalAttrs >>> 16 : null;

    entries.push({ index: i, name, method, dosTime, dosDate, crc, csize, usize, unixMode, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(buf, entry, zipPath) {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw zerr(`failed to read entry ${entry.index}: bad local header in '${zipPath}'`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.csize);

  // Abort if an entry inflates past its declared size (malformed archive).
  const limit = Math.max((entry.usize + 64) * 2, 1024 * 1024);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: limit });
    } catch (e) {
      if (e.code === 'ERR_BUFFER_TOO_LARGE' || /memory limit/i.test(e.message ?? '')) {
        throw zerr(`uncompressed output exceeded ${limit} bytes (zip bomb?)`);
      }
      throw zerr(`failed to read entry ${entry.index}: ${e.message}`);
    }
  } else {
    throw zerr(`failed to read entry ${entry.index}: unsupported compression method ${entry.method}`);
  }
  if (data.length > limit) {
    throw zerr(`uncompressed output exceeded ${limit} bytes (zip bomb?)`);
  }
  if ((zlib.crc32(data) >>> 0) !== entry.crc) {
    throw zerr(`failed to read entry ${entry.index}: CRC mismatch`);
  }
  return data;
}

function dosToDate(dosDate, dosTime) {
  if (dosDate === 0) return null;
  const y = 1980 + (dosDate >> 9);
  const mo = (dosDate >> 5) & 15;
  const d = dosDate & 31;
  const h = dosTime >> 11;
  const mi = (dosTime >> 5) & 63;
  const s = (dosTime & 31) * 2;
  if (mo < 1 || mo > 12 || d < 1) return null;
  // DOS timestamps carry no zone; treat them as UTC (same as the native engine).
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// ── name safety ─────────────────────────────────────────────────────────────

function isReservedWindowsName(s) {
  // Windows ignores trailing dots/spaces on path components.
  const t = s.replace(/[ .]+$/, '');
  const stem = t.split('.', 1)[0].toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem)) return true;
  return /^(COM|LPT)[0-9\u00B9\u00B2\u00B3]$/.test(stem);
}

// Lexically normalise an entry name into safe relative segments, or null when
// the path cannot be contained (matches the native engine's `enclosed_name`
// plus its NUL / reserved-name / backslash rejections).
function safeSegments(name) {
  if (name.includes('\0') || name.includes('\\')) return null;
  const out = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (isReservedWindowsName(seg)) return null;
    out.push(seg);
  }
  return out;
}

// Case-fold + NFC-normalise a path for map keys: what APFS/NTFS conflate at
// lookup time must collide here too.
const foldKey = (p) => p.normalize('NFC').toLowerCase();

// ── directory creation without symlink traversal ────────────────────────────

function ensureDirNofollow(dirPath, destCanon, cache) {
  if (cache.has(dirPath)) return;
  const suffix = path.relative(destCanon, dirPath);
  let cur = destCanon;
  for (const seg of suffix === '' ? [] : suffix.split(path.sep)) {
    cur = path.join(cur, seg);
    if (cache.has(cur)) continue;
    let st = null;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') throw zerr(`failed to stat '${cur}': ${e.message}`);
    }
    if (st === null) {
      try {
        fs.mkdirSync(cur);
      } catch (e) {
        throw zerr(`failed to create directory '${cur}': ${e.message}`);
      }
    } else if (st.isSymbolicLink()) {
      throw zerr(`refusing to traverse symlink at '${cur}'`);
    } else if (!st.isDirectory()) {
      throw zerr(`cannot create directory '${cur}': a file already exists there`);
    }
    cache.add(cur);
  }
}

// ── symlink target verification (port of verify_symlink_target) ─────────────

function pushRel(work, target) {
  const segs = target.split('/');
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s === '' || s === '.') {
      if (i === 0 && s === '') return false; // leading '/' → absolute
      continue;
    }
    work.push(s);
  }
  return true;
}

function verifySymlinkTarget(parent, target, destCanon, linkMap) {
  if (target === '' || path.isAbsolute(target) || target.startsWith('/')) {
    return { err: 'target is absolute or empty' };
  }
  const work = [];
  if (!pushRel(work, target)) return { err: 'target is absolute or empty' };

  let cur = parent;
  let hops = 0;
  while (work.length > 0) {
    const seg = work.pop();
    if (seg === '..') {
      if (cur === destCanon) return { err: 'target escapes destination' };
      cur = path.dirname(cur);
      continue;
    }
    cur = path.join(cur, seg);
    // Is `cur` a symlink — pending from this archive, or on disk?
    let hop = null;
    let fromArchive = false;
    const pending = linkMap.get(foldKey(cur));
    if (pending !== undefined) {
      hop = pending;
      fromArchive = true;
    } else {
      try {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) hop = fs.readlinkSync(cur);
      } catch (e) {
        if (e.code !== 'ENOENT') return { err: 'target is unreadable' };
      }
    }
    if (hop !== null) {
      // A pending ARCHIVE link as the final component is verified by its own
      // pass; a pre-existing on-disk link never is, so it must be followed.
      if (work.length === 0 && fromArchive) break;
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return { err: 'too many levels of symlinks in target' };
      cur = path.dirname(cur);
      if (path.isAbsolute(hop) || hop.startsWith('/')) return { err: 'target is absolute or empty' };
      if (!pushRel(work, hop.replaceAll('\\', '/'))) return { err: 'target is absolute or empty' };
    }
  }
  // Security boundary: keep the containment check unconditional.
  if (cur === destCanon || cur.startsWith(destCanon + path.sep)) return { ok: cur };
  return { err: 'target escapes destination' };
}

// Whether the verified resolved target is a directory, following remaining
// pending hops first, then the on-disk tree. Only used on Windows, where the
// link type must be decided up front.
function resolvedTargetIsDir(resolved, linkMap) {
  let cur = resolved;
  for (let i = 0; i < MAX_SYMLINK_HOPS; i++) {
    const t = linkMap.get(foldKey(cur));
    if (t === undefined) {
      try {
        return fs.statSync(cur).isDirectory();
      } catch {
        return false;
      }
    }
    let next = path.dirname(cur);
    for (const seg of t.replaceAll('\\', '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') next = path.dirname(next);
      else next = path.join(next, seg);
    }
    cur = next;
  }
  return false;
}

function createSymlink(outPath, target, destCanon, linkMap) {
  const parent = path.dirname(outPath);
  const res = verifySymlinkTarget(parent, target, destCanon, linkMap);
  if (res.err) {
    throw zerr(`refusing to create symlink '${outPath}' -> '${target}': ${res.err}`);
  }
  let st = null;
  try {
    st = fs.lstatSync(outPath);
  } catch {}
  if (st !== null) {
    if (st.isDirectory()) {
      throw zerr(`cannot create symlink '${outPath}': a directory already exists there`);
    }
    try {
      fs.unlinkSync(outPath);
    } catch (e) {
      throw zerr(`failed to remove existing '${outPath}': ${e.message}`);
    }
  }
  try {
    if (isWindows) {
      // NTFS reparse points do not treat '/' as a separator, and Windows
      // symlinks are typed — same rewrite and type choice as the native engine.
      const winTarget = target.replaceAll('/', '\\');
      const type = resolvedTargetIsDir(res.ok, linkMap) ? 'dir' : 'file';
      fs.symlinkSync(winTarget, outPath, type);
    } else {
      fs.symlinkSync(target, outPath);
    }
  } catch (e) {
    // Windows without symlink privilege: skip rather than fail the extract.
    if (isWindows && (e.code === 'EPERM' || e.code === 'EACCES')) return;
    throw zerr(`failed to create symlink '${outPath}': ${e.message}`);
  }
}

// ── file writing ─────────────────────────────────────────────────────────────

function writeOne(outPath, data, mode, mtime) {
  let fd;
  try {
    fd = fs.openSync(outPath, 'wx', mode);
  } catch (e) {
    if (e.code !== 'EEXIST') throw zerr(`failed to create '${outPath}': ${e.message}`);
    // Unlink + retry: never open() through a pre-existing symlink.
    try {
      fs.unlinkSync(outPath);
    } catch (e2) {
      throw zerr(`failed to remove existing '${outPath}': ${e2.message}`);
    }
    fd = fs.openSync(outPath, 'wx', mode);
  }
  try {
    fs.writeSync(fd, data);
    // open() applies the process umask; fchmod so the archive bits land exactly.
    if (!isWindows) {
      try {
        fs.fchmodSync(fd, mode & MODE_MASK);
      } catch {}
    }
    if (mtime) {
      try {
        fs.futimesSync(fd, mtime, mtime);
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Extract `zipPath` into the absolute directory `dest`. Same contract and
 * containment guarantees as the native engine.
 *
 * @param {string} zipPath
 * @param {string} dest
 * @returns {Promise<void>}
 */
export async function extractJs(zipPath, dest) {
  let buf;
  try {
    buf = fs.readFileSync(zipPath);
  } catch (e) {
    throw zerr(`failed to open archive '${zipPath}': ${e.message}`);
  }
  const entries = readEntries(buf, zipPath);

  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    throw zerr(`failed to create destination '${dest}': ${e.message}`);
  }
  const destCanon = fs.realpathSync(dest);

  // Pass 1 (like the native engine): path checks + directory creation.
  // Symlinks are NOT created here, so every intermediate component that pass
  // 2 writes through is a real directory.
  const safeDirs = new Set([destCanon]);
  const dirFixups = [];
  const files = [];
  const symlinks = [];

  for (const entry of entries) {
    const mode = entry.unixMode === null ? null : entry.unixMode & MODE_MASK;
    const mtime = dosToDate(entry.dosDate, entry.dosTime);
    const segs = safeSegments(entry.name);
    if (segs === null) {
      throw zerr(`refusing to extract '${entry.name}': path escapes destination`);
    }
    if (segs.length === 0) continue; // '.' / '/' — nothing to create
    const outPath = path.join(destCanon, ...segs);

    if (entry.name.endsWith('/')) {
      ensureDirNofollow(outPath, destCanon, safeDirs);
      dirFixups.push({ outPath, mode: mode ?? DEFAULT_DIR_MODE, mtime });
      continue;
    }
    ensureDirNofollow(path.dirname(outPath), destCanon, safeDirs);

    if (entry.unixMode !== null && (entry.unixMode & S_IFMT) === S_IFLNK) {
      if (entry.usize > MAX_SYMLINK_TARGET) {
        throw zerr(`symlink target exceeds ${MAX_SYMLINK_TARGET} bytes`);
      }
      const target = entryData(buf, entry, zipPath).toString('utf8').replace(/\0+$/, '');
      if (Buffer.byteLength(target) > MAX_SYMLINK_TARGET) {
        throw zerr(`symlink target exceeds ${MAX_SYMLINK_TARGET} bytes`);
      }
      symlinks.push({ outPath, target });
      continue;
    }

    files.push({ entry, outPath, mode: mode ?? DEFAULT_FILE_MODE, mtime });
  }

  // Pass 2: regular files.
  for (const f of files) {
    const data = entryData(buf, f.entry, zipPath);
    writeOne(f.outPath, data, f.mode, f.mtime);
  }

  // Pass 3: symlinks, verified against the on-disk tree AND the pending set.
  const linkMap = new Map();
  for (const s of symlinks) {
    const key = foldKey(s.outPath);
    if (linkMap.has(key)) {
      throw zerr(`refusing archive with duplicate symlink entry '${s.outPath}'`);
    }
    linkMap.set(key, s.target);
  }
  for (const s of symlinks) {
    createSymlink(s.outPath, s.target, destCanon, linkMap);
  }

  // Pass 4: directory perms/mtimes, deepest first.
  dirFixups.sort((a, b) => b.outPath.length - a.outPath.length);
  for (const d of dirFixups) {
    let st = null;
    try {
      st = fs.lstatSync(d.outPath);
    } catch {}
    if (st === null || !st.isDirectory()) continue;
    if (!isWindows) {
      try {
        fs.chmodSync(d.outPath, d.mode);
      } catch {}
    }
    if (d.mtime) {
      try {
        fs.utimesSync(d.outPath, d.mtime, d.mtime);
      } catch {}
    }
  }
}

export default extractJs;
