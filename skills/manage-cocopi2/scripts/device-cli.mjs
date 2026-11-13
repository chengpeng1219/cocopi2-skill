#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DeviceManager } from './device-manager.js';

const exec = promisify(execFile);
const actions = new Set(['doctor','scan','devices','connect-usb','connect-wifi','status','info','disconnect','run','start','programs','stop','log','web']);
const cliKeys = new Set(['serial','host','user','port','device','command','name','workdir','program','lines','timeout','state']);
const help = `Usage: node <skill-dir>/scripts/device-cli.mjs <action> [--key value]
Actions: doctor, scan, devices, connect-usb, connect-wifi, status, info, disconnect,
         run, start, programs, stop, log, web
Examples:
  node scripts/device-cli.mjs scan
  node scripts/device-cli.mjs connect-usb --serial cocopi2
  node scripts/device-cli.mjs connect-wifi --host 192.168.1.50 --user root --port 22
  node scripts/device-cli.mjs run --device <id> --command "uname -a"
  node scripts/device-cli.mjs start --device <id> --name monitor --command "python3 main.py"
State: .cocopi2/manager.json in current working directory; --state <absolute path> overrides it.`;

function options(argv) {
  const [action, ...rest] = argv;
  if (!actions.has(action)) throw new TypeError(`${action ? `Unknown action: ${action}\n` : ''}${help}`);
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.startsWith('--') ? rest[i].slice(2) : '';
    if (!cliKeys.has(key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--') || key in opts) throw new TypeError(`Expected unique --key value pair: ${rest[i] ?? '(missing)'}\n${help}`);
    opts[key] = rest[i + 1];
  }
  return { action, opts };
}
function required(opts, key) {
  const value = opts[key];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`--${key} is required`);
  return value;
}
function boundedInteger(value, key, min, max) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < min || number > max) throw new TypeError(`--${key} must be an integer between ${min} and ${max}`);
  return number;
}
async function doctor() {
  const result = { node: process.version, ssh: { ok: false }, adb: { ok: false } };
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js >=20 is required');
  try {
    const { stdout, stderr } = await exec('ssh', ['-V'], { timeout: 4000, windowsHide: true });
    result.ssh = { ok: true, executable: 'ssh', version: (stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch (error) { result.ssh = { ok: false, error: String(error.message).slice(0, 300) }; }
  try {
    const exe = await new DeviceManager().resolveAdbExecutable(4000);
    const { stdout, stderr } = await exec(exe, ['version'], { timeout: 4000, windowsHide: true });
    result.adb = { ok: true, executable: exe, version: (stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch (error) { result.adb = { ok: false, error: String(error.message).slice(0, 300) }; }
  return result;
}
async function run() {
  const { action, opts } = options(process.argv.slice(2));
  if (action === 'doctor') {
    const report = await doctor();
    return { ...report, ok: report.ssh.ok || report.adb.ok };
  }
  if (action === 'web') {
    if (opts.state) throw new TypeError('web uses a separate in-memory state; --state is not supported');
    console.error('Starting local-only web dashboard at http://127.0.0.1:8787/ (Ctrl+C to stop)');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1' } });
    const close = () => child.kill();
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    return new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => done({ serverExitCode: code }));
    });
  }
  if (opts.timeout && !['scan','connect-usb','connect-wifi','status','info','disconnect','run','start','programs','stop','log'].includes(action)) throw new TypeError('--timeout is not supported for this action');
  const stateFile = opts.state === undefined ? resolve(process.cwd(), '.cocopi2', 'manager.json') : resolve(opts.state);
  if (opts.state && !isAbsolute(opts.state)) throw new TypeError('--state must be an absolute path');
  const manager = new DeviceManager();
  try {
    manager.importState(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Unable to read state (${stateFile}): ${error.message}`);
  }
  let result;
  const deviceId = () => required(opts, 'device');
  const timeoutMs = boundedInteger(opts.timeout, 'timeout', 500, 120000);
  const deviceOptions = () => ({ deviceId: deviceId(), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  switch (action) {
    case 'scan': result = await manager.discoverDevices({ transports: ['usb'], ...(timeoutMs === undefined ? {} : { timeoutMs }) }); break;
    case 'devices': result = manager.listDevices(); break;
    case 'connect-usb': result = await manager.connectDevice({ transport: 'usb', adbSerial: required(opts, 'serial'), ...(timeoutMs === undefined ? {} : { timeoutMs }) }); break;
    case 'connect-wifi': result = await manager.connectDevice({ transport: 'wifi', host: required(opts, 'host'), username: required(opts, 'user'), port: boundedInteger(opts.port, 'port', 1, 65535) ?? 22, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); break;
    case 'status': result = await manager.getConnectionStatus(deviceOptions()); break;
    case 'info': result = await manager.getDeviceInfo(deviceOptions()); break;
    case 'disconnect': result = await manager.disconnectDevice(deviceOptions()); break;
    case 'run': result = await manager.runCommand({ ...deviceOptions(), command: required(opts, 'command') }); break;
    case 'start': result = await manager.startProgram({ ...deviceOptions(), name: required(opts, 'name'), command: required(opts, 'command'), workdir: opts.workdir }); break;
    case 'programs': result = await manager.listPrograms(deviceOptions()); break;
    case 'stop': result = await manager.stopProgram({ ...deviceOptions(), programId: required(opts, 'program') }); break;
    case 'log': result = await manager.readProgramLog({ ...deviceOptions(), programId: required(opts, 'program'), lines: boundedInteger(opts.lines, 'lines', 1, 500) }); break;
  }
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(manager.exportState(), null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, stateFile);
    if (process.platform !== 'win32') await chmod(stateFile, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return result;
}

try {
  const result = await run();
  const success = result?.ok === false || result?.state === 'offline' ? false : !(Array.isArray(result) && result.some((item) => item.state === 'unavailable'));
  console.log(JSON.stringify({ ok: success, result }));
  if (!success) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 1000) }));
  process.exitCode = 1;
}
