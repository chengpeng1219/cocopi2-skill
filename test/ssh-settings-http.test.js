import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer(envOverrides = {}) {
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ...envOverrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  while (!output.includes('listening at')) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    if (Date.now() - started > 5000) throw new Error(`server start timeout: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, url: output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] };
}

test('local SSH settings encrypt the shared password and restore only within same key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cocopi2-ssh-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 42).toString('base64');
  const file = join(dir, 'secret.json');
  const { child, url } = await startServer({ COCOPI2_SECRET_KEY: key, COCOPI2_SECRET_FILE: file });
  t.after(() => child.kill());
  const post = await fetch(`${url}/local-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshPassword: 'shared-secret' }) });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { result: { sshPasswordConfigured: true, strictHostKeyChecking: false, hostKeyMode: 'accept-new' } });
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes('shared-secret'));
  const settings = JSON.parse(saved);
  assert.equal(settings.version, 1);
  assert.ok(settings.iv && settings.tag && settings.data);
  const response = await fetch(`${url}/local-settings`);
  assert.deepEqual(await response.json(), { sshPasswordConfigured: true, strictHostKeyChecking: false, hostKeyMode: 'accept-new', localOnly: true });
});

test('server refuses off-loopback bind when encrypted password is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cocopi2-ssh-secret-bind-'));
  try {
    const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, HOST: '0.0.0.0', PORT: '0', COCOPI2_SSH_PASSWORD: 'secret', COCOPI2_SSH_STRICT_HOST_KEY_CHECKING: 'false' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.match(stderr, /non-loopback interface/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
