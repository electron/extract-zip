// Regression tests for the symlink-chain escape class. Each test crafts a zip
// in-memory and asserts no on-disk effect outside `dest` (and no effect at all
// where the archive should be rejected).

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import extract from '../index.js';

const isUnix = process.platform !== 'win32';
const S_IFLNK = 0o120000;

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const crc = crc32(data);
    const mode = e.mode ?? 0o100644;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([lfh, name, data]));
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE((mode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cdh, name]));
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ez-sec-'));
}

// Detect whether the destination filesystem conflates names that differ only
// in case (APFS default, NTFS) — the case-fold attack only bites there.
function caseInsensitiveFS(dir) {
  const probe = path.join(dir, '.ez-CaseProbe');
  fs.writeFileSync(probe, '');
  const hit = fs.existsSync(path.join(dir, '.ez-caseprobe'));
  fs.rmSync(probe);
  return hit;
}

describe('symlink chain escape', { skip: !isUnix }, () => {
  test('case-mismatched hop cannot escape on a case-insensitive FS', async (t) => {
    // bughunt #1 (critical): link_map keys/lookups are byte-exact, but APFS/NTFS
    // resolve names case-insensitively. Declare the hop as `Back`, reference it
    // as `back` — verifier misses the map, kernel later follows it.
    const root = scratch();
    if (!caseInsensitiveFS(root)) return t.skip('case-sensitive filesystem');

    const secret = path.join(root, 'SECRET');
    fs.writeFileSync(secret, 'OUTSIDE');
    const dest = path.join(root, 'a', 'b'); // two levels deep so ../../SECRET = root/SECRET
    fs.mkdirSync(dest, { recursive: true });

    const zip = path.join(root, 'poc.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'escape', data: 'deep/back/deep/back/../../SECRET', mode: S_IFLNK | 0o777 },
        { name: 'deep/Back', data: '..', mode: S_IFLNK | 0o777 },
      ]),
    );

    let rejected = false;
    await extract(zip, { dir: dest }).catch(() => { rejected = true; });

    // Either the archive is refused, or — if accepted — the resulting `escape`
    // link must not resolve to anything outside `dest`.
    if (!rejected) {
      assert.throws(
        () => fs.readFileSync(path.join(dest, 'escape'), 'utf8'),
        /** containment broken if this read succeeds with 'OUTSIDE' */
      );
    }
    // Hard invariant either way:
    let leaked = '';
    try { leaked = fs.readFileSync(path.join(dest, 'escape'), 'utf8'); } catch {}
    assert.notEqual(leaked, 'OUTSIDE', 'symlink escaped destination on case-insensitive FS');
  });

  test('NFC/NFD-mismatched hop cannot escape on a normalising FS', async (t) => {
    // APFS also normalises Unicode: U+00E9 (é) == U+0065 U+0301 (é). Same bypass.
    const root = scratch();
    const nfc = 'é';
    const nfd = 'é';
    fs.writeFileSync(path.join(root, `.probe-${nfc}`), '');
    const normalising = fs.existsSync(path.join(root, `.probe-${nfd}`));
    if (!normalising) return t.skip('non-normalising filesystem');

    fs.writeFileSync(path.join(root, 'SECRET'), 'OUTSIDE');
    const dest = path.join(root, 'a', 'b');
    fs.mkdirSync(dest, { recursive: true });

    const zip = path.join(root, 'poc.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'escape', data: `deep/b${nfd}ck/deep/b${nfd}ck/../../SECRET`, mode: S_IFLNK | 0o777 },
        { name: `deep/b${nfc}ck`, data: '..', mode: S_IFLNK | 0o777 },
      ]),
    );

    await extract(zip, { dir: dest }).catch(() => {});
    let leaked = '';
    try { leaked = fs.readFileSync(path.join(dest, 'escape'), 'utf8'); } catch {}
    assert.notEqual(leaked, 'OUTSIDE', 'symlink escaped via Unicode-normalisation mismatch');
  });

  test('symlink target routed through another symlink cannot escape', async () => {
    const root = scratch();
    const dest = path.join(root, 'a', 'b');
    fs.writeFileSync(path.join(root, 'SECRET'), 'outside\n');
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'deep/back', data: '..', mode: S_IFLNK | 0o777 },
        { name: 'escape', data: 'deep/back/deep/back/../../SECRET', mode: S_IFLNK | 0o777 },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }), /escapes destination/);
    assert.ok(!fs.existsSync(path.join(dest, 'escape')));
  });

  test('symlink swap via raw-name alias cannot redirect a queued file', async () => {
    const root = scratch();
    const dest = path.join(root, 'x', 'y');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const victim = path.join(root, 'sub', 'PWNED');
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'deep/back', data: '..', mode: S_IFLNK | 0o777 },
        { name: 'a', data: 'deep', mode: S_IFLNK | 0o777 },
        { name: 'a/sub/PWNED', data: 'owned\n' },
        { name: './a', data: 'deep/back/deep/back/../..', mode: S_IFLNK | 0o777 },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }));
    assert.ok(!fs.existsSync(victim), `wrote outside dest: ${victim}`);
  });

  test('symlink swap cannot redirect a queued chmod', async () => {
    const root = scratch();
    const dest = path.join(root, 'x', 'y');
    const victim = path.join(root, 'victim');
    fs.writeFileSync(victim, 'precious');
    fs.chmodSync(victim, 0o644);
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'deep/back', data: '..', mode: S_IFLNK | 0o777 },
        { name: 'a', data: 'deep', mode: S_IFLNK | 0o777 },
        { name: 'a/victim/', mode: 0o040777 },
        { name: './a', data: 'deep/back/deep/back/../..', mode: S_IFLNK | 0o777 },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }));
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
  });

  test('mkdir never creates a stray dir outside dest', async () => {
    const root = scratch();
    const dest = path.join(root, 'a', 'b');
    const stray = path.join(root, 'STRAY');
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        { name: 'deep/back', data: '..', mode: S_IFLNK | 0o777 },
        { name: 'escape', data: 'deep/back/deep/back/../..', mode: S_IFLNK | 0o777 },
        { name: 'escape/STRAY/f', data: 'x' },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }));
    assert.ok(!fs.existsSync(stray), `created outside dest: ${stray}`);
  });

  test('pre-existing symlink in dest is not traversed', async () => {
    const root = scratch();
    const dest = path.join(root, 'd');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(root, path.join(dest, 'out'));
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(zip, rawZip([{ name: 'out/PWNED', data: 'x' }]));
    await assert.rejects(() => extract(zip, { dir: dest }), /traverse symlink/);
    assert.ok(!fs.existsSync(path.join(root, 'PWNED')));
  });

  test('aliased duplicate symlink entries are rejected', async () => {
    const dest = scratch();
    const zip = path.join(dest, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'a', data: 'x', mode: S_IFLNK | 0o777 },
        { name: './a', data: 'y', mode: S_IFLNK | 0o777 },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }), /duplicate symlink entry/);
  });

  test('chain escape is caught regardless of entry order', async () => {
    const root = scratch();
    const dest = path.join(root, 'a', 'b');
    fs.writeFileSync(path.join(root, 'SECRET'), 'outside\n');
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'deep/', mode: 0o040755 },
        // `escape` BEFORE `deep/back` — resolver must consult the pending set.
        { name: 'escape', data: 'deep/back/deep/back/../../SECRET', mode: S_IFLNK | 0o777 },
        { name: 'deep/back', data: '..', mode: S_IFLNK | 0o777 },
      ]),
    );
    await assert.rejects(() => extract(zip, { dir: dest }), /escapes destination/);
    assert.ok(!fs.existsSync(path.join(dest, 'escape')));
  });

  test('framework-style symlink chain (Current → A) extracts', async () => {
    const dest = scratch();
    const zip = path.join(dest, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'F.framework/Versions/A/Libraries/', mode: 0o040755 },
        { name: 'F.framework/Versions/A/Libraries/libfoo', data: 'lib\n' },
        { name: 'F.framework/Versions/Current', data: 'A', mode: S_IFLNK | 0o777 },
        { name: 'F.framework/Libraries', data: 'Versions/Current/Libraries', mode: S_IFLNK | 0o777 },
      ]),
    );
    await extract(zip, { dir: dest });
    assert.equal(
      fs.readFileSync(path.join(dest, 'F.framework', 'Libraries', 'libfoo'), 'utf8'),
      'lib\n',
    );
  });

  test('link → link (final component) is allowed', async () => {
    const root = scratch();
    const dest = path.join(root, 'd');
    const zip = path.join(root, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'target', data: 'hello\n' },
        { name: 'one', data: 'target', mode: S_IFLNK | 0o777 },
        { name: 'two', data: 'one', mode: S_IFLNK | 0o777 },
      ]),
    );
    await extract(zip, { dir: dest });
    assert.equal(fs.readFileSync(path.join(dest, 'two'), 'utf8'), 'hello\n');
  });
});

describe('hardening', () => {
  test('setuid/setgid/sticky bits are stripped', { skip: !isUnix }, async () => {
    const dest = scratch();
    const zip = path.join(dest, 'x.zip');
    fs.writeFileSync(
      zip,
      rawZip([
        { name: 'f', data: 'x', mode: 0o104755 },
        { name: 'd/', mode: 0o042755 },
      ]),
    );
    await extract(zip, { dir: dest });
    assert.equal(fs.statSync(path.join(dest, 'f')).mode & 0o7000, 0);
    assert.equal(fs.statSync(path.join(dest, 'd')).mode & 0o7000, 0);
  });

  test('oversized symlink target is rejected without large allocation', async () => {
    const dest = scratch();
    const zip = path.join(dest, 'x.zip');
    fs.writeFileSync(zip, rawZip([{ name: 'l', data: 'x'.repeat(5000), mode: S_IFLNK | 0o777 }]));
    await assert.rejects(() => extract(zip, { dir: dest }), /exceeds 4096 bytes/);
  });

  test('reserved Windows name with trailing space is rejected', async () => {
    const dest = scratch();
    const zip = path.join(dest, 'x.zip');
    fs.writeFileSync(zip, rawZip([{ name: 'aux ', data: 'x' }]));
    await assert.rejects(() => extract(zip, { dir: dest }), /escapes destination/);
  });
});
