import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device-manager.js';
import { programStartScript, shellQuote, validProgramId } from '../src/programs.js';

const ADB = 'D:\\Program Files (x86)\\pcsuite\\adb_41\\adb.exe';
const noAdbServer = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

function fakeAdb(responder) {
  return async (exe, args) => {
    if (args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41' };
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nSER1 device transport_id:1\n' };
    return responder(args.at(-1) ?? '', args);
  };
}

test('startProgram runs the program detached and reports running state', async () => {
  const scripts = [];
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: fakeAdb(async (script) => {
    scripts.push(script);
    if (script.includes('nohup')) return { stdout: 'STARTED\r\nCOCOPI-START-END\r\n', stderr: '' };
    return { stdout: 'hello from program\r\n', stderr: '' };
  }) });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  await manager.connectDevice({ deviceId: usb.id, transport: 'usb' });
  const started = await manager.startProgram({ deviceId: usb.id, name: 'blink LED', command: 'sh blink.sh' });
  assert.equal(started.ok, true);
  assert.equal(started.state, 'running');
  assert.match(started.id, /^[a-z0-9]{16}$/);
  assert.ok(scripts.some((script) => script.includes('nohup') && script.includes('blink.sh')));
  assert.equal(started.log, 'hello from program\r\n');
});

test('startProgram reports exited when the command dies immediately', async () => {
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: fakeAdb(async (script) => script.includes('nohup') ? { stdout: 'EXITED\n', stderr: '' } : { stdout: 'sh: blink.sh: not found\n', stderr: '' }) });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  const started = await manager.startProgram({ deviceId: usb.id, name: 'bad', command: 'sh blink.sh' });
  assert.equal(started.ok, false);
  assert.equal(started.state, 'exited');
  assert.match(started.log, /not found/);
});

test('listPrograms merges remote state with locally known names and hides unmanaged rows', async () => {
  let remoteRows = '';
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: fakeAdb(async (script) => {
    if (script.includes('nohup')) return { stdout: 'STARTED\r\n', stderr: '' };
    if (script.includes('for f in')) return { stdout: remoteRows, stderr: '' };
    return { stdout: '', stderr: '' };
  }) });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  const started = await manager.startProgram({ deviceId: usb.id, name: '温度采集', command: 'sh temp.sh' });
  // 设备上可能有历史遗留的 pid 文件，只展示本服务启动并登记过的程序
  remoteRows = `${started.id}|running|4321|sh temp.sh \r\nabc123|stopped|999|\r\n`;
  const { programs } = await manager.listPrograms({ deviceId: usb.id });
  assert.equal(programs.length, 1);
  assert.equal(programs[0].name, '温度采集');
  assert.equal(programs[0].managed, true);
  assert.equal(programs[0].pid, 4321);
});

test('stopProgram maps remote results to state', async () => {
  const outputs = ['STOPPED\r\n', 'NOT_RUNNING\r\n', 'STOP_FAILED\r\n'];
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: fakeAdb(async (script) => {
    if (script.includes('kill "$pid"')) return { stdout: outputs.shift(), stderr: '' };
    return { stdout: '', stderr: '' };
  }) });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  const ok = await manager.stopProgram({ deviceId: usb.id, programId: 'abc123' });
  assert.equal(ok.ok, true);
  const idle = await manager.stopProgram({ deviceId: usb.id, programId: 'abc123' });
  assert.equal(idle.ok, true);
  const failed = await manager.stopProgram({ deviceId: usb.id, programId: 'abc123' });
  assert.equal(failed.ok, false);
  assert.equal(failed.state, 'stop_failed');
});

test('program inputs are validated before touching the device', async () => {
  const manager = new DeviceManager({ adbSocketTransport: noAdbServer, runner: fakeAdb(async () => ({ stdout: '' })) });
  const [usb] = await manager.discoverDevices({ transports: ['usb'] });
  await assert.rejects(manager.startProgram({ deviceId: usb.id, name: '', command: 'ls' }), /name is required/);
  await assert.rejects(manager.startProgram({ deviceId: usb.id, name: 'x', command: '   ' }), /command is required/);
  await assert.rejects(manager.startProgram({ deviceId: usb.id, name: 'x', command: 'ls', workdir: '/tmp/%s' }), /must not contain/);
  await assert.rejects(manager.stopProgram({ deviceId: usb.id, programId: '../../etc/passwd' }), /programId is invalid/);
  assert.throws(() => validProgramId('a b'), /programId is invalid/);
});

test('start script writes a device-side run file and quotes user input', () => {
  const script = programStartScript({ id: 'abc', command: 'python3 "run it.py"', workdir: "/opt/my app" });
  // 用户命令被单独写入脚本文件，避免 adb shell 多层引号解析
  assert.ok(script.includes(`printf '%s' `), script);
  assert.ok(script.includes(shellQuote("/opt/my app")), script);
  assert.ok(script.includes('python3 "run it.py"'), script);
  assert.ok(script.includes('nohup sh /tmp/cocopi2-programs/abc.run.sh < /dev/null > /tmp/cocopi2-programs/abc.log 2>&1 &'), script);
  assert.ok(script.includes('echo $! > /tmp/cocopi2-programs/abc.pid'), script);
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const noWorkdir = programStartScript({ id: 'xyz', command: 'task', workdir: '' });
  assert.ok(!noWorkdir.includes('cd '), noWorkdir);
});