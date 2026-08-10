// The JavaScript fallback engine must give the same containment guarantees
// as the native engine. Rerun the full extract + security suites against it
// (EXTRACT_ZIP_FORCE_JS routes index.js to js-fallback.js), and check the
// fallback trigger itself: a broken native binding must produce a working
// extraction plus a warning that carries the real load error.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('js fallback engine', () => {
  test('passes the full extract + security suites', () => {
    // One child process runs both suites with the fallback forced; this file
    // is excluded from the child run to avoid recursion.
    execFileSync(
      process.execPath,
      ['--test', 'test/extract.test.js', 'test/security.test.js'],
      {
        cwd: ROOT,
        env: { ...process.env, EXTRACT_ZIP_FORCE_JS: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
  });

  test('broken native binding: warns and extracts via the fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-fallback-'));
    const bad = path.join(dir, 'garbage.node');
    fs.writeFileSync(bad, 'this is not a shared library');

    const script = `
      import { execSync } from 'node:child_process';
      import extract from ${JSON.stringify(path.join(ROOT, 'index.js').replaceAll('\\\\', '/'))};
      const warnings = [];
      process.on('warning', (w) => warnings.push(w.message));
      const dir = ${JSON.stringify(dir)};
      const zip = dir + '/t.zip';
      // Build a tiny zip with the OS tooling available everywhere Node runs CI.
      import fs from 'node:fs';
      import path from 'node:path';
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'hello.txt'), 'hi from fallback\\n');
      if (process.platform === 'win32') {
        execSync('tar -a -c -f ' + JSON.stringify(zip) + ' hello.txt', { cwd: path.join(dir, 'src') });
      } else {
        execSync('zip -q ' + JSON.stringify(zip) + ' hello.txt', { cwd: path.join(dir, 'src') });
      }
      await extract(zip, { dir: path.join(dir, 'out') });
      setImmediate(() => {
        console.log(JSON.stringify({
          content: fs.readFileSync(path.join(dir, 'out', 'hello.txt'), 'utf8'),
          warnings,
        }));
      });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: bad, EXTRACT_ZIP_FORCE_JS: '' },
      encoding: 'utf8',
    });
    const res = JSON.parse(out);
    assert.equal(res.content, 'hi from fallback\n');
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /native binding did not load/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
