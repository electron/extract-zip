import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import extract from '../index.js';
import { makeFixtures, FIXTURES as F, symlinkAbsInsideFor, MTIME } from './make-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out');
const isUnix = process.platform !== 'win32';

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  await makeFixtures();
});
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

let n = 0;
function freshOut() {
  const dir = path.join(OUT, `t${n++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
const read = (p) => fs.readFileSync(p, 'utf8');
const mode = (p) => fs.statSync(p).mode & 0o777;

// Windows only allows symlink creation with SeCreateSymbolicLinkPrivilege
// (elevation or Developer Mode); without it the extractor skips links by
// design, so link-resolution tests are only meaningful when it's held.
function canSymlink() {
  if (isUnix) return true;
  const probe = path.join(os.tmpdir(), `extract-zip-symlink-probe-${process.pid}`);
  try {
    fs.rmSync(probe, { force: true });
    fs.symlinkSync('x', probe, 'file');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────

describe('correctness', () => {
  test('extracts files, nested dirs, empty dir', async () => {
    const dir = freshOut();
    await extract(F.basic, { dir });
    assert.equal(read(path.join(dir, 'hello.txt')), 'hello world\n');
    assert.equal(read(path.join(dir, 'sub', 'nested.txt')), 'nested\n');
    assert.ok(fs.statSync(path.join(dir, 'empty')).isDirectory());
  });

  test('preserves file mode bits', { skip: !isUnix }, async () => {
    const dir = freshOut();
    await extract(F.basic, { dir });
    assert.equal(mode(path.join(dir, 'bin', 'tool.sh')), 0o755);
  });

  test('file mode is exact, not umask-filtered', { skip: !isUnix }, async (t) => {
    // bughunt #4: open(2) applies umask to OpenOptionsExt::mode(); upstream
    // extract-zip chmods after write so the archive mode is honoured exactly.
    const dir = freshOut();
    const old = process.umask(0o077);
    t.after(() => process.umask(old));
    await extract(F.basic, { dir });
    assert.equal(
      mode(path.join(dir, 'bin', 'tool.sh')),
      0o755,
      `expected 0o755; umask 0o077 filtered it to 0o${mode(path.join(dir, 'bin', 'tool.sh')).toString(8)}`,
    );
  });

  test('preserves directory mode bits', { skip: !isUnix }, async () => {
    const dir = freshOut();
    await extract(F.basic, { dir });
    assert.equal(mode(path.join(dir, 'empty')), 0o750);
  });

  test('applies default mode when archive has none', { skip: !isUnix }, async () => {
    const dir = freshOut();
    await extract(F['no-mode'], { dir });
    assert.equal(mode(path.join(dir, 'plain.txt')), 0o644);
  });

  test('preserves mtimes', async () => {
    const dir = freshOut();
    await extract(F.basic, { dir });
    const got = fs.statSync(path.join(dir, 'hello.txt')).mtime.getTime();
    // DOS timestamps carry no zone; allow ±24h for write-side/read-side TZ.
    assert.ok(Math.abs(got - MTIME.getTime()) < 24 * 3600_000, `mtime ${got} vs ${MTIME.getTime()}`);
    // …and prove it came from the archive, not the extraction time.
    assert.ok(Date.now() - got > 7 * 24 * 3600_000);
  });

  test('utf-8, spaces, long names, zero-byte', async () => {
    const dir = freshOut();
    await extract(F['edge-names'], { dir });
    assert.equal(read(path.join(dir, 'ünïcödé', '文件', '🦀.txt')), 'utf8');
    assert.equal(read(path.join(dir, 'with spaces & (parens).txt')), 'sp');
    assert.equal(fs.statSync(path.join(dir, 'zero-byte')).size, 0);
    assert.equal(read(path.join(dir, 'l'.repeat(200) + '.txt')), 'long');
  });

  test('empty / 1-byte / >256KB files', async () => {
    const dir = freshOut();
    await extract(F.sizes, { dir });
    assert.equal(fs.statSync(path.join(dir, 'empty.bin')).size, 0);
    assert.equal(fs.statSync(path.join(dir, 'one-byte.bin')).size, 1);
    const big = fs.readFileSync(path.join(dir, 'large.bin'));
    assert.equal(big.length, 512 * 1024);
    assert.ok(big.every((b) => b === 0x41));
  });

  test('200 files (parallelism)', async () => {
    const dir = freshOut();
    await extract(F.many, { dir });
    for (let i = 0; i < 200; i++) {
      assert.equal(read(path.join(dir, 'f', `${i}.txt`)), String(i));
    }
  });

  test('30-deep directory chain', async () => {
    const dir = freshOut();
    await extract(F.deep, { dir });
    const leaf = path.join(dir, ...Array.from({ length: 30 }, (_, i) => `d${i}`), 'leaf.txt');
    assert.equal(read(leaf), 'deep');
  });

  test('archive with only directories', async () => {
    const dir = freshOut();
    await extract(F['dirs-only'], { dir });
    assert.ok(fs.statSync(path.join(dir, 'a', 'b')).isDirectory());
    assert.ok(fs.statSync(path.join(dir, 'c')).isDirectory());
  });

  test('duplicate entry name: last one wins', async () => {
    const dir = freshOut();
    await extract(F.duplicate, { dir });
    assert.equal(read(path.join(dir, 'dup.txt')), 'second');
  });

  test('`.` and inside-`.. ` are normalised', async () => {
    const dir = freshOut();
    await extract(F['dotdot-inside'], { dir });
    assert.equal(read(path.join(dir, 'a', 'c.txt')), 'ok');
    const dir2 = freshOut();
    await extract(F['cur-dir'], { dir: dir2 });
    assert.equal(read(path.join(dir2, 'a', 'b.txt')), 'ok');
  });
});

describe('security', () => {
  test('zip-slip `..` is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F.slip, { dir }), /escapes destination/);
    assert.ok(!fs.existsSync(path.join(OUT, 'evil.txt')));
  });

  test('zip-slip via mid-path `..` is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F['slip-mid'], { dir }), /escapes destination/);
  });

  test('backslash separators cannot traverse', async () => {
    const dir = freshOut();
    // Either rejected, or extracted as a literal filename — never escapes.
    await extract(F['slip-backslash'], { dir }).catch(() => {});
    assert.ok(!fs.existsSync(path.join(OUT, 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(path.dirname(OUT), 'evil.txt')));
  });

  test('absolute path entry lands inside dir', async () => {
    const dir = freshOut();
    await extract(F.absolute, { dir });
    assert.ok(fs.existsSync(path.join(dir, 'rooted.txt')));
    assert.ok(!fs.existsSync('/rooted.txt'));
  });

  test('NUL byte in name is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F['nul-name'], { dir }), /escapes destination/);
  });

  test('Windows reserved name is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F.reserved, { dir }), /escapes destination/);
  });

  test('entry lying about uncompressed size is caught', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F.liar, { dir }), /exceeded|zip bomb/i);
  });
});

describe('symlinks', { skip: !isUnix }, () => {
  test('relative target inside dest is created', async () => {
    const dir = freshOut();
    await extract(F['symlink-ok'], { dir });
    const link = path.join(dir, 'link.txt');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(read(link), 'target contents\n');
  });

  test('absolute target inside dest is rejected', async () => {
    // Absolute symlink targets are now refused outright; even when they happen
    // to land inside `dir` they're system-specific and break if `dir` moves.
    const dir = freshOut();
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, '_.zip');
    fs.writeFileSync(zip, symlinkAbsInsideFor(fs.realpathSync(dir)));
    await assert.rejects(() => extract(zip, { dir }), /target is absolute/);
  });

  test('relative target escaping dest is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F['symlink-bad'], { dir }), /escapes destination/);
  });

  test('absolute target outside dest is rejected', async () => {
    const dir = freshOut();
    await assert.rejects(() => extract(F['symlink-abs-outside'], { dir }), /target is absolute/);
  });

  test('symlink-then-file chain cannot write outside dest', async () => {
    const dir = freshOut();
    const sentinel = path.join(os.tmpdir(), 'extract-zip-owned.txt');
    fs.rmSync(sentinel, { force: true });
    await assert.rejects(() => extract(F['symlink-chain'], { dir }), /target is absolute/);
    assert.ok(!fs.existsSync(sentinel));
  });

  test('self-referential symlink is created (no hang)', async () => {
    const dir = freshOut();
    await extract(F['symlink-self'], { dir });
    assert.ok(fs.lstatSync(path.join(dir, 'loop')).isSymbolicLink());
  });

  test('existing symlink at file path is replaced, not followed', async () => {
    const dir = freshOut();
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(OUT, 'outside-target');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.symlinkSync(outside, path.join(dir, 'hello.txt'));
    await extract(F.basic, { dir });
    assert.equal(read(path.join(dir, 'hello.txt')), 'hello world\n');
    assert.equal(read(outside), 'ORIGINAL'); // not clobbered through the link
    assert.ok(!fs.lstatSync(path.join(dir, 'hello.txt')).isSymbolicLink());
  });
});

// Unlike the block above, this runs on Windows too (when the privilege is
// held) — it's the platform where link type and separator handling can break.
describe('symlinks (all platforms)', { skip: !canSymlink() }, () => {
  // Regression for electron/fuses on Windows: the darwin Electron zip's
  // framework links must come out traversable — correct link type for the
  // directory link, and no raw '/' left in the stored targets.
  test('framework-style link chain resolves through both hops', async () => {
    const dir = freshOut();
    await extract(F.framework, { dir });
    const fw = path.join(dir, 'Test.framework');
    assert.ok(fs.lstatSync(path.join(fw, 'Versions', 'Current')).isSymbolicLink());
    assert.ok(fs.statSync(path.join(fw, 'Versions', 'Current')).isDirectory());
    assert.ok(fs.lstatSync(path.join(fw, 'Test')).isSymbolicLink());
    assert.equal(read(path.join(fw, 'Test')), 'framework binary\n');
  });
});

describe('behaviour', () => {
  test('rejects relative dir', async () => {
    await assert.rejects(() => extract(F.basic, { dir: 'rel' }), /absolute/);
  });

  test('rejects missing dir option', async () => {
    await assert.rejects(() => extract(F.basic, {}), /dir is required/);
    await assert.rejects(() => extract(F.basic), /dir is required/);
  });

  test('creates dir if it does not exist', async () => {
    const dir = path.join(freshOut(), 'a', 'b', 'c');
    await extract(F.basic, { dir });
    assert.ok(fs.existsSync(path.join(dir, 'hello.txt')));
  });

  test('overwrites existing files', async () => {
    const dir = freshOut();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'OLD');
    await extract(F.basic, { dir });
    assert.equal(read(path.join(dir, 'hello.txt')), 'hello world\n');
  });

  test('idempotent: second extract over the first is a no-op diff', async () => {
    const dir = freshOut();
    await extract(F.basic, { dir });
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    await extract(F.basic, { dir });
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
    assert.equal(read(path.join(dir, 'hello.txt')), 'hello world\n');
  });

  test('two concurrent extracts to different dirs', async () => {
    const a = freshOut();
    const b = freshOut();
    await Promise.all([extract(F.many, { dir: a }), extract(F.many, { dir: b })]);
    assert.equal(fs.readdirSync(path.join(a, 'f')).length, 200);
    assert.equal(fs.readdirSync(path.join(b, 'f')).length, 200);
  });

  test('parallel result is deterministic (5 runs identical)', async () => {
    const ref = freshOut();
    await extract(F.many, { dir: ref });
    const refList = fs.readdirSync(path.join(ref, 'f')).sort();
    for (let i = 0; i < 5; i++) {
      const dir = freshOut();
      await extract(F.many, { dir });
      assert.deepEqual(fs.readdirSync(path.join(dir, 'f')).sort(), refList);
    }
  });
});

describe('errors', () => {
  test('missing archive', async () => {
    await assert.rejects(
      () => extract(path.join(OUT, 'nope.zip'), { dir: freshOut() }),
      /failed to open archive/,
    );
  });

  test('not a zip file', async () => {
    await assert.rejects(
      () => extract(F['not-a-zip'], { dir: freshOut() }),
      /failed to read archive/,
    );
  });

  test('corrupt deflate stream', async () => {
    await assert.rejects(() => extract(F.corrupt, { dir: freshOut() }));
  });
});
