// Builds every test zip at runtime. Benign archives use yazl; anything yazl
// would (rightly) refuse — `..`, absolute paths, lying headers, raw symlink
// modes — is hand-encoded with `rawZip()`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'fixtures');
const S_IFLNK = 0o120000;

// ── minimal zip writer: arbitrary names, modes, declared sizes ────────────

function crc32(buf) {
  return (zlib.crc32 ? zlib.crc32(buf) : crc32Fallback(buf)) >>> 0;
}
function crc32Fallback(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/**
 * @param {Array<{name:string, data?:Buffer|string, mode?:number,
 *   deflate?:boolean, declaredSize?:number}>} entries
 */
function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const stored = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(raw);
    const usize = e.declaredSize ?? raw.length; // allow lying
    const csize = stored.length;
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x0021, 12); // 1980-01-01
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(csize, 18);
    lfh.writeUInt32LE(usize, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lfh, name, stored]);
    locals.push(local);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x0021, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(csize, 20);
    cdh.writeUInt32LE(usize, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE((mode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cdh, name]));

    offset += local.length;
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

// ── yazl helper ───────────────────────────────────────────────────────────

function writeYazl(file, build) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    build(z);
    z.outputStream.pipe(fs.createWriteStream(file)).on('error', reject).on('close', resolve);
    z.end();
  });
}

// ── fixture catalogue ─────────────────────────────────────────────────────

const F = {};
const builders = [];
function fixture(name, build) {
  const file = path.join(DIR, name + '.zip');
  F[name] = file;
  builders.push(() => build(file));
}

const MTIME = new Date(1_700_000_000_000); // 2023-11-14T22:13:20Z

fixture('basic', (f) =>
  writeYazl(f, (z) => {
    z.addBuffer(Buffer.from('hello world\n'), 'hello.txt', { mtime: MTIME });
    z.addBuffer(Buffer.from('nested\n'), 'sub/nested.txt', { mtime: MTIME });
    z.addBuffer(Buffer.from('#!/bin/sh\necho hi\n'), 'bin/tool.sh', { mode: 0o100755, mtime: MTIME });
    z.addEmptyDirectory('empty/', { mode: 0o040750, mtime: MTIME });
  }),
);

fixture('edge-names', (f) =>
  writeYazl(f, (z) => {
    z.addBuffer(Buffer.from('utf8'), 'ünïcödé/文件/🦀.txt');
    z.addBuffer(Buffer.from('sp'), 'with spaces & (parens).txt');
    z.addBuffer(Buffer.alloc(0), 'zero-byte');
    z.addBuffer(Buffer.from('long'), 'l'.repeat(200) + '.txt');
  }),
);

fixture('sizes', (f) =>
  writeYazl(f, (z) => {
    z.addBuffer(Buffer.alloc(0), 'empty.bin');
    z.addBuffer(Buffer.from('x'), 'one-byte.bin');
    z.addBuffer(Buffer.alloc(512 * 1024, 'A'), 'large.bin'); // > WRITE_BUF_MAX
  }),
);

fixture('many', (f) =>
  writeYazl(f, (z) => {
    for (let i = 0; i < 200; i++) z.addBuffer(Buffer.from(String(i)), `f/${i}.txt`);
  }),
);

fixture('deep', (f) =>
  writeYazl(f, (z) => {
    z.addBuffer(Buffer.from('deep'), Array.from({ length: 30 }, (_, i) => `d${i}`).join('/') + '/leaf.txt');
  }),
);

fixture('dirs-only', (f) =>
  writeYazl(f, (z) => {
    z.addEmptyDirectory('a/');
    z.addEmptyDirectory('a/b/');
    z.addEmptyDirectory('c/');
  }),
);

fixture('duplicate', (f) =>
  fs.writeFileSync(f, rawZip([
    { name: 'dup.txt', data: 'first' },
    { name: 'dup.txt', data: 'second' },
  ])),
);

fixture('no-mode', (f) => {
  // version-made-by = DOS (0) → no unix mode bits; should get defaults.
  const buf = rawZip([{ name: 'plain.txt', data: 'x' }]);
  buf.writeUInt16LE(20, buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 4); // host=0
  fs.writeFileSync(f, buf);
});

// ── security fixtures ─────────────────────────────────────────────────────

fixture('slip', (f) => fs.writeFileSync(f, rawZip([{ name: '../evil.txt', data: 'owned\n' }])));
fixture('slip-mid', (f) => fs.writeFileSync(f, rawZip([{ name: 'a/../../evil.txt', data: 'x' }])));
fixture('slip-backslash', (f) =>
  fs.writeFileSync(f, rawZip([{ name: 'a\\..\\..\\evil.txt', data: 'x' }])),
);
fixture('absolute', (f) => fs.writeFileSync(f, rawZip([{ name: '/rooted.txt', data: 'rooted\n' }])));
fixture('dotdot-inside', (f) =>
  fs.writeFileSync(f, rawZip([{ name: 'a/b/../c.txt', data: 'ok' }])),
);
fixture('cur-dir', (f) => fs.writeFileSync(f, rawZip([{ name: './a/./b.txt', data: 'ok' }])));
fixture('nul-name', (f) => fs.writeFileSync(f, rawZip([{ name: 'a\0b.txt', data: 'x' }])));
fixture('reserved', (f) => fs.writeFileSync(f, rawZip([{ name: 'sub/COM1.txt', data: 'x' }])));

fixture('symlink-ok', (f) =>
  fs.writeFileSync(f, rawZip([
    { name: 'target.txt', data: 'target contents\n' },
    { name: 'link.txt', data: 'target.txt', mode: S_IFLNK | 0o777 },
  ])),
);
fixture('symlink-abs-inside', (f) => {
  // target is absolute, but inside dest — placeholder replaced at test time.
  fs.writeFileSync(f, rawZip([
    { name: 'target.txt', data: 'abs\n' },
    { name: 'link.txt', data: '__DEST__/target.txt', mode: S_IFLNK | 0o777 },
  ]));
});
fixture('symlink-bad', (f) =>
  fs.writeFileSync(f, rawZip([
    { name: 'bad-link', data: '../../../../../../etc/passwd', mode: S_IFLNK | 0o777 },
  ])),
);
fixture('symlink-abs-outside', (f) =>
  fs.writeFileSync(f, rawZip([
    { name: 'bad-link', data: '/etc/passwd', mode: S_IFLNK | 0o777 },
  ])),
);
fixture('symlink-chain', (f) =>
  fs.writeFileSync(f, rawZip([
    { name: 'escape', data: os.tmpdir(), mode: S_IFLNK | 0o777 },
    { name: 'escape/extract-zip-owned.txt', data: 'owned\n' },
  ])),
);
fixture('symlink-self', (f) =>
  fs.writeFileSync(f, rawZip([{ name: 'loop', data: 'loop', mode: S_IFLNK | 0o777 }])),
);

fixture('liar', (f) =>
  // Declares 100 bytes; actually inflates to 2 MB → LimitedWriter must trip.
  fs.writeFileSync(f, rawZip([
    { name: 'bomb.bin', data: Buffer.alloc(2 * 1024 * 1024), deflate: true, declaredSize: 100 },
  ])),
);

fixture('corrupt', (f) => {
  const buf = rawZip([{ name: 'a.txt', data: 'hello', deflate: true }]);
  // Flip a byte in the deflate stream.
  buf[35] ^= 0xff;
  fs.writeFileSync(f, buf);
});

fixture('not-a-zip', (f) => fs.writeFileSync(f, 'this is not a zip file'));

async function makeFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const b of builders) await b();
}

/** Build a single-use zip with an absolute symlink target pointing at `dest`. */
function symlinkAbsInsideFor(dest) {
  return rawZip([
    { name: 'target.txt', data: 'abs\n' },
    { name: 'link.txt', data: path.join(dest, 'target.txt'), mode: S_IFLNK | 0o777 },
  ]);
}

export { makeFixtures, F as FIXTURES, rawZip, symlinkAbsInsideFor, MTIME };
