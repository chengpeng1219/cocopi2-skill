import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboard } from '../src/page.js';

const script = dashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('inline dashboard script parses as a single valid module scope', () => {
  assert.ok(script, 'script block must exist');
  const dir = mkdtempSync(join(tmpdir(), 'cocopi-page-'));
  const file = join(dir, 'page-script.mjs');
  writeFileSync(file, script);
  try {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard declares each top-level function only once', () => {
  const names = [...script.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  assert.ok(names.length > 0, 'expected top-level function declarations');
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `duplicated function declarations: ${duplicates.join(', ')}`);
});