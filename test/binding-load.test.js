// Regression tests for electron/electron#52481 (2): when the bundled prebuild
// exists but cannot be loaded (dlopen refused by an OS policy, truncated
// file, wrong format), binding.js must surface that error, not the generic
// "npm has a bug related to optional dependencies" message. That message
// stays only for the genuinely-missing-file case.
//
// `NAPI_RS_NATIVE_LIBRARY_PATH` routes the loader at a path of our choice, so
// both cases are reproducible on every platform without a code-integrity
// policy. Each case runs in a child process because binding.js loads at
// module scope.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINDING = path.join(__dirname, '..', 'binding.js');

function loadBindingWith(nativePath) {
  const script = `
    import(${JSON.stringify(BINDING)}).then(
      () => { console.log(JSON.stringify({ ok: true })); },
      (err) => {
        console.log(JSON.stringify({ ok: false, code: err.code ?? null, message: err.message }));
      },
    );
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: nativePath },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('binding load errors', () => {
  test('unloadable prebuild: the dlopen error is surfaced, not the npm advice', () => {
    // A present-but-unloadable .node file is the same failure class that an
    // OS code-integrity block produces: require() finds the file and dlopen
    // fails with ERR_DLOPEN_FAILED.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-binding-'));
    const bad = path.join(dir, 'garbage.node');
    fs.writeFileSync(bad, 'this is not a shared library');

    const res = loadBindingWith(bad);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ERR_DLOPEN_FAILED');
    assert.ok(!/npm has a bug/.test(res.message), `npm advice leaked: ${res.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('missing prebuild: the aggregate message is kept', () => {
    const res = loadBindingWith(path.join(os.tmpdir(), 'ez-binding-does-not-exist.node'));
    assert.equal(res.ok, false);
    assert.match(res.message, /Cannot find native binding/);
  });
});
