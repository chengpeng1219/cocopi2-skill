import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const start = Date.now();
  while (!output.includes('listening at')) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    if (Date.now() - start > 5000) throw new Error(`server start timeout: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, output);
  return { child, url };
}

test('root shows web device management dashboard', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const root = await fetch(`${url}/`);
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /设备管理/);
  assert.match(html, /wifiForm/);
  assert.match(html, /scanUsb/);
  assert.match(html, /test_ssh/);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'ok' });
});

test('dashboard renders terminal controls wired to run_command', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const html = await (await fetch(`${url}/`)).text();
  assert.match(html, /id="terminalDevice"/);
  assert.match(html, /id="command"/);
  assert.match(html, /\/tools\/run_command/);
  const { tools } = await (await fetch(`${url}/tools`)).json();
  assert.ok(tools.includes('run_command'));
});

test('run_command validates input before touching a device', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const post = (body) => fetch(`${url}/tools/run_command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ deviceId: 'nope', command: '' })).status, 400);
  assert.equal((await post({ deviceId: 'nope', command: 'x'.repeat(5000) })).status, 400);
  assert.equal((await post({ deviceId: 'nope', command: 'ls', timeoutMs: 10 })).status, 400);
  assert.equal((await post({ deviceId: 'nope', command: 'ls' })).status, 502);
});

test('dashboard renders the program panel wired to the program tools', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const html = await (await fetch(`${url}/`)).text();
  assert.match(html, /id="programName"/);
  assert.match(html, /id="programCommand"/);
  assert.match(html, /id="programWorkdir"/);
  assert.match(html, /id="startProgram"/);
  assert.match(html, /id="programs"/);
  assert.match(html, /id="programLog"/);
  assert.match(html, /\/tools\/start_program/);
  const { tools } = await (await fetch(`${url}/tools`)).json();
  for (const tool of ['start_program', 'stop_program', 'list_programs', 'program_log']) assert.ok(tools.includes(tool), tool);
});

test('program endpoints validate input before touching a device', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/tools/start_program', { deviceId: 'nope', command: 'ls' })).status, 400);
  assert.equal((await post('/tools/start_program', { deviceId: 'nope', name: 'x' })).status, 400);
  assert.equal((await post('/tools/start_program', { deviceId: 'nope', name: 'x', command: 'ls', workdir: '/tmp/%s' })).status, 400);
  assert.equal((await post('/tools/stop_program', { deviceId: 'nope', programId: '../../etc' })).status, 400);
  assert.equal((await post('/tools/program_log', { deviceId: 'nope', programId: 'abc', lines: 0 })).status, 502);
  assert.equal((await post('/tools/start_program', { deviceId: 'nope', name: 'x', command: 'ls' })).status, 502);
});

test('SSH diagnostic endpoint returns structured error rather than an opaque 502', async (t) => {
  const { child, url } = await startServer();
  t.after(() => child.kill());
  const response = await fetch(`${url}/tools/test_ssh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', username: 'root', port: 1, timeoutMs: 1000 }),
  });
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ssh_failed');
});
