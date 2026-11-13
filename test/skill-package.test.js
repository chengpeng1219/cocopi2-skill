import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeviceManager } from '../skills/manage-cocopi2/scripts/device-manager.js';

const exec = promisify(execFile);
const cli = resolve('skills/manage-cocopi2/scripts/device-cli.mjs');
const runCli = (args, cwd) => exec(process.execPath, [cli, ...args], { cwd, timeout: 10000, windowsHide: true });

test('portable skill exports and imports only connection/program metadata', async () => {
  const stub = async (exe, args) => args[0] === 'version' ? { stdout: 'adb' } : { stdout: '' };
  const first = new DeviceManager({ runner: stub, adbSocketTransport: async () => '' });
  const device = await first.connectDevice({ transport: 'wifi', host: '192.0.2.2', username: 'root' });
  const snapshot = first.exportState();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.programs.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('password'));
  const next = new DeviceManager({ runner: stub });
  next.importState(snapshot);
  assert.equal(next.listDevices()[0].id, device.id);
  assert.deepEqual(next.exportState(), snapshot);
  assert.throws(() => next.importState({ devices: [{ ...snapshot.devices[0], host: 'example.com;rm -rf /' }], programs: [] }), /Invalid state file/);
  assert.throws(() => next.importState({ devices: snapshot.devices, programs: [{ id: '0123456789abcdef', name: 'x', command: 'ls', deviceId: 'unknown' }] }), /Invalid state file/);
});

test('CLI uses caller workspace and persists state across invocations', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cocopi2-skill-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const list = JSON.parse((await runCli(['devices'], cwd)).stdout);
  assert.deepEqual(list, { ok: true, result: [] });
  const path = join(cwd, '.cocopi2', 'manager.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(state, { devices: [], programs: [] });
  assert.deepEqual(JSON.parse((await runCli(['devices'], cwd)).stdout), list);
  await assert.rejects(runCli(['run', '--device', 'missing', '--command', 'uname -a'], cwd), (error) => {
    assert.match(error.stderr, /Unknown deviceId/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), state);
});

test('CLI rejects tampered state and does not execute a device command', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cocopi2-skill-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'bad.json');
  await writeFile(path, JSON.stringify({ devices: [{ id: '00000000-0000-0000-0000-000000000000', transport: 'usb', adbSerial: 'x;cat /etc/passwd' }], programs: [] }));
  await assert.rejects(runCli(['run', '--state', path, '--device', '00000000-0000-0000-0000-000000000000', '--command', 'uname -a'], cwd), (error) => {
    assert.match(error.stderr, /Invalid state file/);
    return true;
  });
});
