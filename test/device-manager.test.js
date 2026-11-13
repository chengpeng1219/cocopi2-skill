import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device-manager.js';

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');
const noAdbServer = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5037'), { code: 'ECONNREFUSED' }); };

test('USB discovery parses adb device records and connection uses serial', async () => {
  const calls = [];
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: async (...args) => { calls.push(args); return { stdout: 'List of devices attached\nABC123 device product:cocopi2\nOFFLINE offline\n' }; }, now: fixedNow });
  const found = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(found.length, 2);
  assert.equal(found[0].state, 'available');
  assert.equal(found[1].state, 'offline');
  const connected = await manager.connectDevice({ deviceId: found[0].id, transport: 'usb' });
  assert.equal(connected.state, 'connected');
  assert.deepEqual(calls.at(-1)[1], ['-s', 'ABC123', 'get-state']);
});

test('Wi-Fi SSH username is applied to connect and status checks', async () => {
  const calls = [];
  const manager = new DeviceManager({ runner: async (exe, args) => { calls.push(args); return { stdout: '' }; }, now: fixedNow });
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local', username: 'root' });
  assert.equal(device.endpoint, 'root@cocopi.local:22');
  await manager.getConnectionStatus({ deviceId: device.id });
  assert.ok(calls[0].includes('root@cocopi.local'));
  assert.ok(calls[1].includes('root@cocopi.local'));
});

test('Wi-Fi connect passes password to Python SSH bridge over stdin, never argv', async () => {
  const calls = [];
  const manager = new DeviceManager({ sshPassword: 'test-only-secret', strictHostKeyChecking: false, allowNewHostKeys: true, runner: async (exe, args, options) => {
    calls.push({ exe, args, options });
    return { stdout: '', stderr: '' };
  } });
  const device = await manager.connectDevice({ transport: 'wifi', host: '192.0.2.5', username: 'root' });
  assert.equal(device.state, 'connected');
  assert.equal(calls[0].exe, process.env.COCOPI2_PYTHON ?? 'python');
  assert.match(calls[0].args[0], /ssh_password_bridge\.py$/);
  assert.ok(!calls[0].args.join(' ').includes('test-only-secret'));
  assert.deepEqual(calls[0].options.input, Buffer.concat([Buffer.from('16\n'), Buffer.from('test-only-secret')]));
  assert.ok(calls[0].args.includes('false'));
});

test('Wi-Fi connect uses batch SSH, known hosts, and the selected port', async () => {
  let argsSeen;
  const manager = new DeviceManager({ runner: async (exe, args) => { assert.equal(exe, 'ssh'); argsSeen = args; return { stdout: '' }; }, now: fixedNow });
  const connected = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local', port: 2222 });
  assert.equal(connected.endpoint, 'cocopi.local:2222');
  assert.ok(argsSeen.includes('BatchMode=yes'));
  assert.ok(argsSeen.includes('StrictHostKeyChecking=yes'));
  assert.ok(argsSeen.includes('2222'));
});

test('provides a clear diagnostic when ADB is not installed and no adb server runs', async () => {
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; } });
  const found = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(found[0].state, 'unavailable');
  assert.match(found[0].error, /Android Platform Tools/);
  assert.match(found[0].error, /ADB_EXECUTABLE/);
});

test('USB discovery reuses a running adb server when adb is not on PATH', async () => {
  const services = [];
  const manager = new DeviceManager({
    adbSocketTransport: async (service) => {
      services.push(service);
      return 'cocopi2                device transport_id:1\n';
    },
    runner: async () => { const error = new Error('spawn adb ENOENT'); error.code = 'ENOENT'; throw error; },
  });
  const found = await manager.discoverDevices({ transports: ['usb'] });
  assert.deepEqual(services, ['host:devices-l']);
  assert.equal(found.length, 1);
  assert.equal(found[0].endpoint, 'cocopi2');
  assert.equal(found[0].state, 'available');
  assert.equal(found[0].details, 'transport_id:1');
});

test('explains a missing SSH executable', async () => {
  const manager = new DeviceManager({ runner: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; } });
  await assert.rejects(manager.connectDevice({ transport: 'wifi', host: 'cocopi.local' }), /ssh\.exe/);
});

test('rejects shell syntax in host and invalid timeout', async () => {
  const manager = new DeviceManager({ runner: async () => ({ stdout: '' }) });
  await assert.rejects(manager.connectDevice({ transport: 'wifi', host: 'host;whoami' }), /hostname or IP address/);
  await assert.rejects(manager.discoverDevices({ timeoutMs: 1 }), /timeoutMs/);
});

test('runCommand forwards Wi-Fi commands over SSH with the stored target', async () => {
  const calls = [];
  const manager = new DeviceManager({ runner: async (exe, args) => { calls.push([exe, args]); return { stdout: 'uid=0(root)\n', stderr: '' }; }, now: fixedNow });
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local', username: 'root' });
  const result = await manager.runCommand({ deviceId: device.id, command: 'id -u' });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'uid=0(root)\n');
  assert.equal(calls[1][0], 'ssh');
  assert.equal(calls[1][1].at(-1), 'id -u');
  assert.ok(calls[1][1].includes('root@cocopi.local'));
});

test('runCommand forwards USB commands through adb shell', async () => {
  const calls = [];
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: async (exe, args) => { calls.push([exe, args]); return exe === 'adb' && args[0] === 'devices' ? { stdout: 'List of devices attached\nSER1 device\n' } : { stdout: 'ok\n', stderr: '' }; } });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  await manager.connectDevice({ deviceId: usb.id, transport: 'usb' });
  const result = await manager.runCommand({ deviceId: usb.id, command: 'uname -a' });
  assert.equal(result.ok, true);
  // adb shell 本身已用 `sh -c` 执行命令，不能再叠加一层 `sh -c`，否则复杂脚本会被拆坏。
  assert.deepEqual(calls.at(-1)[1], ['-s', 'SER1', 'shell', 'uname -a']);
});

test('runCommand reports exit code and stderr without throwing', async () => {
  const manager = new DeviceManager({ runner: async (exe, args) => {
    if (args.at(-1) === 'ls /nope') { const error = new Error('Command failed'); error.code = 2; error.stderr = 'ls: /nope: No such file\n'; error.stdout = ''; throw error; }
    return { stdout: '', stderr: '' };
  } });
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local' });
  const result = await manager.runCommand({ deviceId: device.id, command: 'ls /nope' });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /No such file/);
});

test('runCommand rejects empty, oversized, or unknown-device requests', async () => {
  const manager = new DeviceManager({ runner: async () => ({ stdout: '' }) });
  await assert.rejects(manager.runCommand({ deviceId: 'missing', command: 'ls' }), /Unknown deviceId/);
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local' });
  await assert.rejects(manager.runCommand({ deviceId: device.id, command: '   ' }), /command is required/);
  await assert.rejects(manager.runCommand({ deviceId: device.id, command: 'x'.repeat(4001) }), /must not exceed/);
  await assert.rejects(manager.runCommand({ deviceId: device.id, command: 'ls', timeoutMs: 999999 }), /timeoutMs/);
});

test('adbExecutable option is used for every USB command', async () => {
  const adbPath = 'D:\\Program Files (x86)\\pcsuite\\adb\\adb.exe';
  const calls = [];
  const manager = new DeviceManager({ adbExecutable: adbPath, adbSocketTransport: noAdbServer, runner: async (exe, args) => {
    calls.push([exe, args]);
    if (args[0] === 'devices') return { stdout: 'List of devices attached\ncocopi2 device transport_id:1\n' };
    if (args.at(-1) === 'uname -a') return { stdout: 'Linux maixcam2\n' };
    return { stdout: '' };
  } });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(usb.endpoint, 'cocopi2');
  await manager.connectDevice({ deviceId: usb.id, transport: 'usb' });
  await manager.getConnectionStatus({ deviceId: usb.id });
  await manager.getDeviceInfo({ deviceId: usb.id });
  await manager.runCommand({ deviceId: usb.id, command: 'uname -a' });
  assert.ok(calls.length >= 5);
  for (const [exe] of calls) assert.equal(exe, adbPath);
});

test('missing configured adb path names that path in the error', async () => {
  const adbPath = 'C:\\missing\\adb.exe';
  const manager = new DeviceManager({ adbExecutable: adbPath, adbSocketTransport: noAdbServer, runner: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; } });
  const [found] = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(found.state, 'unavailable');
  assert.ok(found.error.includes(adbPath), found.error);
  assert.match(found.error, /ADB_EXECUTABLE/);
});

test('ADB_EXECUTABLE environment variable becomes the default adb path', async () => {
  const previous = process.env.ADB_EXECUTABLE;
  process.env.ADB_EXECUTABLE = 'C:\\tools\\adb.exe';
  try {
    const calls = [];
    const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: async (exe) => { calls.push(exe); return { stdout: 'List of devices attached\n' }; } });
    await manager.discoverDevices({ transports: ['usb'] });
    assert.ok(calls.includes('C:\\tools\\adb.exe'));
    assert.ok(!calls.some((exe) => exe !== 'C:\\tools\\adb.exe'), `unexpected executables: ${calls.join(', ')}`);
  } finally {
    if (previous === undefined) delete process.env.ADB_EXECUTABLE; else process.env.ADB_EXECUTABLE = previous;
  }
});

test('runCommand truncates very large output', async () => {
  const manager = new DeviceManager({ runner: async (exe, args) => args.at(-1) === 'big' ? { stdout: 'a'.repeat(200000), stderr: '' } : { stdout: '' } });
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local' });
  const result = await manager.runCommand({ deviceId: device.id, command: 'big' });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 64 * 1024);
});

test('status changes to offline on command failure and list filters', async () => {
  let fail = false;
  const manager = new DeviceManager({ runner: async () => { if (fail) throw new Error('unreachable'); return { stdout: '' }; }, now: fixedNow });
  const device = await manager.connectDevice({ transport: 'wifi', host: 'cocopi.local' });
  assert.equal(manager.listDevices({ state: 'connected' }).length, 1);
  fail = true;
  assert.equal((await manager.getConnectionStatus({ deviceId: device.id })).state, 'offline');
  assert.equal(manager.listDevices({ state: 'offline' }).length, 1);
});
