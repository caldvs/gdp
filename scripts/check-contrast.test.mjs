import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('reads the Calm tokens from the single :root block and checks every pair', () => {
  const script = fileURLToPath(new URL('./check-contrast.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.stderr, '');
  // 1 = a pair is below 4.5:1, which is a real finding, not a crash.
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
  assert.equal((r.stdout.match(/^(pass|FAIL) /gm) || []).length, 8);
  assert.match(r.stdout, /^pass  light  5\.17:1  --accent on --bg/m);
});
