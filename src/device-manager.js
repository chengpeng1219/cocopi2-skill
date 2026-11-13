import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect as connectSocket } from 'node:net';
import {
  validProgramName,
  validProgramCommand,
  validWorkingDirectory,
  validProgramLogLines,
  validProgramId,
  programIdentifier,
  programListScript,
  programStartScript,
  programStopScript,
  programLogScript,
  truncateLog,
  shellQuote,
} from './programs.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_LENGTH = 4_000;
const MAX_OUTPUT_CHARS = 64 * 1024;

function validTimeout(value) {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function sanitizeError(error) {
  const message = String(error?.message ?? error ?? 'Unknown error');
  return message.replace(/(passphrase|password|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 500);
}

function commandFailure(error, executable, label, configuredPath) {
  if (error?.code === 'ENOENT') {
    const target = configuredPath && configuredPath !== executable ? configuredPath : executable;
    const installHint = executable === 'adb'
      ? `未找到 ${target}。请安装 Android Platform Tools，或设置环境变量 ADB_EXECUTABLE 指向完整的 adb.exe 路径（例如 "D:\\Android\\platform-tools\\adb.exe"）。`
      : `未找到 ${target}。请安装 OpenSSH 客户端，或将 ssh.exe 加入 PATH。`;
    return `${label}: executable "${target}" was not found. ${installHint}`;
  }
  if (error?.code === 'ETIMEDOUT') return `${label}: command timed out.`;
  return `${label}: ${sanitizeError(error)}`;
}

const ADB_SERVER_HOST = '127.0.0.1';
const ADB_SERVER_PORT = 5037;

// 设备端脚本存放在固定目录，多条命令拼成一行时用 `; ` 分隔。
const PROGRAMS_DIR = '/tmp/cocopi2-programs';

async function deviceScript(runner, adb, serial, body, timeoutMs) {
  // adb shell 只把一条命令字符串交给设备 shell；为保证 `;`/`&&` 等被完整执行，
  // 先把脚本写入设备文件，再用最简的 `sh 路径` 调用（该设备上 heredoc 分段会传不完整）。
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const path = `${PROGRAMS_DIR}/_cmd_${id}.sh`;
  const contents = `${body}\n`;
  const write = `mkdir -p ${PROGRAMS_DIR}; printf '%s' ${shellQuote(contents)} > ${path}`;
  const result = await runner(adb, ['-s', serial, 'shell', `${write} && sh ${path}; rc=$?; rm -f ${path}; exit $rc`], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isAdbShellTransportError(error) {
  // 只有 adb shell 本身调用失败（命令根本没能执行）才走脚本文件兜底。
  const text = `${error?.stderr ?? ''}${error?.message ?? ''}`.toLowerCase();
  return text.includes('syntax error') || (text.includes('command not found') && !text.includes('/bin/sh:'));
}

async function adbShell(runner, adb, serial, command, timeoutMs) {
  try {
    return await runner(adb, ['-s', serial, 'shell', command], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (!isAdbShellTransportError(error)) throw error;
    return deviceScript(runner, adb, serial, command, timeoutMs);
  }
}

// 常见的 adb 安装位置；仅在 PATH 与已运行的 adb server 都不可用时作为兜底。
const ADB_DEFAULT_LOCATIONS = [
  'D:\\Program Files (x86)\\pcsuite\\adb_41\\adb.exe',
  'D:\\Program Files (x86)\\pcsuite\\adb\\adb.exe',
  'C:\\Program Files (x86)\\pcsuite\\adb_41\\adb.exe',
  'C:\\Program Files (x86)\\pcsuite\\adb\\adb.exe',
];

async function listAdbDevices(adbSocket, listViaCommand, timeoutMs) {
  // 先复用已在运行的 adb server（别的应用可能已经启动它），失败再用命令行 adb。
  try {
    const response = await adbSocket('host:devices-l', timeoutMs);
    if (typeof response === 'string') return response;
  } catch {
    // 没有可用的 adb server，继续尝试命令行 adb
  }
  return listViaCommand();
}

function smartSocket(service, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: ADB_SERVER_HOST, port: ADB_SERVER_PORT });
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(timeoutMs, () => finish(reject, Object.assign(new Error('adb server request timed out'), { code: 'ETIMEDOUT' })));
    socket.on('error', (error) => finish(reject, error));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.length >= 4) {
        if (buffer.startsWith('FAIL')) {
          const length = parseInt(buffer.slice(4, 8), 16);
          if (buffer.length < 8 + length) return;
          return finish(reject, new Error(`adb server: ${buffer.slice(8, 8 + length)}`));
        }
        if (buffer.startsWith('OKAY')) {
          const remaining = buffer.slice(4);
          // Non-streaming host services (host:version, host:devices-l) reply with a length-prefixed payload.
          if (remaining.length < 4) return;
          const length = parseInt(remaining.slice(0, 4), 16);
          if (!Number.isFinite(length)) return finish(reject, new Error('unexpected adb server response'));
          if (remaining.length < 4 + length) return;
          return finish(resolve, remaining.slice(4, 4 + length));
        }
        return finish(reject, new Error(`unexpected adb server response: ${buffer.slice(0, 20)}`));
      }
    });
    socket.once('connect', () => socket.write(`${service.length.toString(16).padStart(4, '0')}${service}`));
  });
}

async function defaultAdbSocket(service, timeoutMs) {
  // 只有在本机 5037 端口确实在监听时才连接，避免每次 USB 操作都等待连接超时。
  if (!(await isPortOpen(ADB_SERVER_HOST, ADB_SERVER_PORT, Math.min(timeoutMs, 250)))) {
    throw Object.assign(new Error(`no adb server listening on ${ADB_SERVER_HOST}:${ADB_SERVER_PORT}`), { code: 'ECONNREFUSED' });
  }
  return smartSocket(service, timeoutMs);
}

function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectSocket({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function collectStream(stream, maxChars) {
  let text = '';
  let truncated = false;
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    if (text.length < maxChars) text += chunk;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
  }
  return { text, truncated };
}

function sshTarget(host, username) {
  if (username === undefined || username === null || username === '') return host;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new TypeError('username must contain only letters, numbers, dot, underscore or hyphen');
  }
  return `${username}@${host}`;
}

function validCommandTimeout(value) {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS}`);
  }
  return value;
}

function validCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('command is required');
  if (command.length > MAX_COMMAND_LENGTH) throw new TypeError(`command must not exceed ${MAX_COMMAND_LENGTH} characters`);
  if (command.includes('\0')) throw new TypeError('command must not contain null bytes');
  return command.trim();
}

function truncateOutput(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

function commandResult(base, raw) {
  const stdout = truncateOutput(raw.stdout);
  const stderr = truncateOutput(raw.stderr);
  return {
    ...base,
    ok: raw.ok,
    exitCode: raw.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function parseAdbDevices(output) {
  // 兼容命令行输出（首行 "List of devices attached"）与 adb server 的 smart-socket 输出（首行即设备）。
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim());
  if (lines[0] && /^list of devices attached$/i.test(lines[0])) lines.shift();
  return lines.filter(Boolean).map((line) => {
    const [serial, state, ...properties] = line.split(/\s+/);
    return { serial, state, properties: properties.join(' ') };
  }).filter((row) => row.serial && row.state);
}

export class DeviceManager {
  #devices = new Map();
  #programs = new Map();
  #runner;
  #now;
  #adb;
  #adbSocket;

  constructor({ runner = execFileAsync, now = () => new Date(), adbExecutable = process.env.ADB_EXECUTABLE ?? 'adb', adbSocketTransport } = {}) {
    this.#runner = runner;
    this.#now = now;
    this.#adbSocket = adbSocketTransport ?? defaultAdbSocket;
    if (typeof adbExecutable !== 'string' || !adbExecutable.trim()) throw new TypeError('adbExecutable must be a non-empty path or command name');
    this.#adb = adbExecutable.trim();
  }

  listDevices({ transport, state } = {}) {
    return [...this.#devices.values()]
      .filter((device) => !transport || device.transport === transport)
      .filter((device) => !state || device.state === state)
      .map((device) => ({ ...device }));
  }

  async discoverDevices({ transports = ['usb'], hosts = [], username, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    if (!Array.isArray(transports) || transports.some((transport) => !['wifi', 'usb'].includes(transport))) {
      throw new TypeError('transports may contain only wifi and usb');
    }
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string' || !host.trim() || /[\s;&|`$<>]/.test(host))) {
      throw new TypeError('hosts must be an array of hostnames or IP addresses without shell syntax');
    }
    if (username !== undefined && !/^[a-zA-Z0-9._-]+$/.test(username)) throw new TypeError('username must contain only letters, numbers, dot, underscore or hyphen');
    const found = [];
    for (const transport of transports) {
      if (transport === 'usb') {
        let output;
        try {
          output = await listAdbDevices(this.#adbSocket, this.#adbList.bind(this), timeoutMs);
        } catch (error) {
          found.push({ transport, state: 'unavailable', error: commandFailure(error, 'adb', 'USB discovery failed', this.#adb) });
          continue;
        }
        for (const item of parseAdbDevices(output)) {
          const device = this.#upsert({ transport, endpoint: item.serial, adbSerial: item.serial, state: item.state === 'device' ? 'available' : item.state, details: item.properties });
          found.push({ ...device });
        }
      } else {
        for (const host of hosts) {
          const device = this.#upsert({ transport, endpoint: `${username ? `${username}@` : ''}${host}:22`, host, username, port: 22, state: 'candidate' });
          found.push({ ...device });
        }
      }
    }
    return found;
  }

  async connectDevice({ deviceId, transport, host, username, port = 22, adbSerial, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    if (!['wifi', 'usb'].includes(transport)) throw new TypeError('transport must be wifi or usb');
    let existing = deviceId ? this.#devices.get(deviceId) : undefined;
    if (deviceId && !existing) throw new Error(`Unknown deviceId: ${deviceId}`);
    host ??= existing?.host;
    username ??= existing?.username;
    adbSerial ??= existing?.adbSerial ?? (transport === 'usb' ? existing?.endpoint : undefined);
    if (existing && existing.transport !== transport) throw new Error('transport does not match device');

    if (transport === 'wifi') {
      if (typeof host !== 'string' || !host.trim() || /[\s;&|`$<>]/.test(host)) throw new TypeError('host must be a hostname or IP address');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535');
      try {
        const result = await this.#runner('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(port),sshTarget(host, username),'true'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
        if (result.code !== undefined && result.code !== 0) throw new Error(`ssh exited with code ${result.code}`);
      } catch (error) {
        throw new Error(commandFailure(error, 'ssh', 'SSH connection failed'), { cause: error });
      }
      return this.#upsert({ id: existing?.id, transport, endpoint: `${username ? `${username}@` : ''}${host}:${port}`, host, username, port, state: 'connected', connectedAt: this.#now().toISOString() });
    }

    if (typeof adbSerial !== 'string' || !adbSerial.trim() || /[\s;&|`$<>]/.test(adbSerial)) throw new TypeError('adbSerial is required for USB');
    try {
      await this.#runner(await this.#adbExecutable(timeoutMs), ['-s', adbSerial, 'get-state'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(commandFailure(error, 'adb', 'ADB connection failed', this.#adb), { cause: error });
    }
    return this.#upsert({ id: existing?.id, transport, endpoint: adbSerial, adbSerial, state: 'connected', connectedAt: this.#now().toISOString() });
  }

  async disconnectDevice({ deviceId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    const device = this.#requireDevice(deviceId);
    if (device.transport === 'usb') {
      try {
        await this.#runner(await this.#adbExecutable(timeoutMs), ['disconnect', device.adbSerial], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      } catch (error) {
        throw new Error(commandFailure(error, 'adb', 'ADB disconnect failed', this.#adb), { cause: error });
      }
    }
    const next = { ...device, state: 'disconnected', connectedAt: undefined };
    this.#devices.set(deviceId, next);
    return { ...next };
  }

  async getConnectionStatus({ deviceId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    const device = this.#requireDevice(deviceId);
    try {
      if (device.transport === 'wifi') {
        await this.#runner('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(device.port ?? 22),sshTarget(device.host, device.username),'true'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      } else {
        await this.#runner(await this.#adbExecutable(timeoutMs), ['-s', device.adbSerial, 'get-state'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      }
      return { deviceId, transport: device.transport, state: 'connected', checkedAt: this.#now().toISOString() };
    } catch (error) {
      const updated = { ...device, state: 'offline' };
      this.#devices.set(deviceId, updated);
      const executable = device.transport === 'wifi' ? 'ssh' : 'adb';
      return { deviceId, transport: device.transport, state: 'offline', checkedAt: this.#now().toISOString(), error: commandFailure(error, executable, 'Connection check failed', device.transport === 'usb' ? this.#adb : undefined) };
    }
  }

  async getDeviceInfo({ deviceId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    const device = this.#requireDevice(deviceId);
    const args = device.transport === 'wifi'
      ? ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(device.port ?? 22),sshTarget(device.host, device.username),'uname -a']
      : ['-s', device.adbSerial, 'shell', 'uname -a'];
    const executable = device.transport === 'wifi' ? 'ssh' : 'adb';
    try {
      const result = await this.#runner(executable === 'adb' ? await this.#adbExecutable(timeoutMs) : executable, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      return { deviceId, transport: device.transport, endpoint: device.endpoint, os: (result.stdout ?? '').trim() };
    } catch (error) {
      throw new Error(commandFailure(error, executable, 'Could not read device info', executable === 'adb' ? this.#adb : undefined), { cause: error });
    }
  }

  async runCommand({ deviceId, command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    validCommandTimeout(timeoutMs);
    const text = validCommand(command);
    const device = this.#requireDevice(deviceId);
    const base = {
      deviceId,
      transport: device.transport,
      command: text,
      startedAt: this.#now().toISOString(),
    };

    if (device.transport === 'usb') {
      try {
        const result = await adbShell(this.#runner, await this.#adbExecutable(timeoutMs), device.adbSerial, text, timeoutMs);
        return { ...commandResult(base, { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr }), finishedAt: this.#now().toISOString() };
      } catch (error) {
        const stderr = error.code === 'ENOENT' ? commandFailure(error, 'adb', 'Command failed', this.#adb) : (error.stderr ?? sanitizeError(error));
        return { ...commandResult(base, { ok: false, exitCode: typeof error.code === 'number' ? error.code : null, stdout: error.stdout, stderr }), finishedAt: this.#now().toISOString() };
      }
    }

    try {
      const result = await this.#runner('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(device.port ?? 22),sshTarget(device.host, device.username),text], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { ...commandResult(base, { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr }), finishedAt: this.#now().toISOString() };
    } catch (error) {
      const exitCode = error.code === 'ENOENT' || error.code === 'ETIMEDOUT' ? null : (typeof error.code === 'number' ? error.code : null);
      const stderr = error.code === 'ENOENT'
        ? commandFailure(error, 'ssh', 'Command failed')
        : (error.stderr || sanitizeError(error));
      return { ...commandResult(base, { ok: false, exitCode, stdout: error.stdout, stderr }), finishedAt: this.#now().toISOString() };
    }
  }

  async startProgram({ deviceId, name, command, workdir, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    validCommandTimeout(timeoutMs);
    const label = validProgramName(name);
    const text = validProgramCommand(command);
    const directory = validWorkingDirectory(workdir);
    this.#requireDevice(deviceId);
    const id = programIdentifier();
    const result = await this.runCommand({ deviceId, command: `${programStartScript({ id, command: text, workdir: directory })}; echo COCOPI-START-END`, timeoutMs });
    const started = /(^|\r?\n)STARTED(\r?\n|$)/.test(result.stdout ?? '');
    const program = { id, name: label, command: text, workdir: directory, deviceId, state: started ? 'running' : 'exited', startedAt: this.#now().toISOString() };
    this.#programs.set(id, program);
    const log = await this.readProgramLog({ deviceId, programId: id, lines: 20 }).catch(() => ({ log: '' }));
    return { ...program, ok: result.ok && started, remote: result, log: log.log };
  }

  async listPrograms({ deviceId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    validCommandTimeout(timeoutMs);
    this.#requireDevice(deviceId);
    const result = await this.runCommand({ deviceId, command: programListScript(), timeoutMs });
    const remote = (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [id, state, pid, cmd] = line.split('|');
      return { id, state, pid: Number(pid) || null, remoteCommand: cmd ?? '' };
    });
    const programs = remote
      .filter((item) => this.#programs.has(item.id))
      .map((item) => {
        const local = this.#programs.get(item.id);
        return {
          ...item,
          name: local.name,
          command: local.command,
          workdir: local.workdir ?? '',
          startedAt: local.startedAt ?? null,
          managed: true,
          deviceId,
        };
      })
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return { programs, ok: result.ok, remote: result };
  }

  async stopProgram({ deviceId, programId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    validCommandTimeout(timeoutMs);
    const id = validProgramId(programId);
    this.#requireDevice(deviceId);
    const result = await this.runCommand({ deviceId, command: programStopScript(id), timeoutMs });
    const stopped = /(^|\r?\n)(STOPPED|NOT_RUNNING)(\r?\n|$)/.test(result.stdout ?? '');
    const local = this.#programs.get(id);
    if (local) this.#programs.set(id, { ...local, state: stopped ? (result.stdout.includes('NOT_RUNNING') ? 'not_running' : 'stopped') : 'stop_failed', stoppedAt: this.#now().toISOString() });
    return { programId: id, deviceId, ok: result.ok && stopped, state: stopped ? 'stopped' : 'stop_failed', remote: result };
  }

  async readProgramLog({ deviceId, programId, lines, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validTimeout(timeoutMs);
    this.#requireDevice(deviceId);
    const id = validProgramId(programId);
    const count = validProgramLogLines(lines);
    const result = await this.runCommand({ deviceId, command: programLogScript(id, count), timeoutMs: Math.max(timeoutMs, MIN_TIMEOUT_MS) });
    const { log, truncated } = truncateLog(result.stdout);
    return { programId: id, deviceId, ok: result.ok, log, truncated, remote: result };
  }

  async #adbExecutable(timeoutMs) {
    const candidates = this.#adb === 'adb' ? [this.#adb, ...ADB_DEFAULT_LOCATIONS] : [this.#adb];
    for (const candidate of candidates) {
      try {
        await this.#runner(candidate, ['version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
        return candidate;
      } catch (error) {
        if (error?.code !== 'ENOENT') return candidate;
      }
    }
    throw Object.assign(new Error(`${this.#adb} was not found`), { code: 'ENOENT' });
  }

  async #adbList(timeoutMs) {
    let commandError;
    try {
      const executable = await this.#adbExecutable(timeoutMs);
      const result = await this.#runner(executable, ['devices', '-l'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      return result.stdout ?? '';
    } catch (error) {
      commandError = error;
    }
    throw commandError;
  }

  #requireDevice(deviceId) {
    if (typeof deviceId !== 'string' || !this.#devices.has(deviceId)) throw new Error(`Unknown deviceId: ${deviceId}`);
    return this.#devices.get(deviceId);
  }

  #upsert(fields) {
    const current = fields.id ? this.#devices.get(fields.id) : undefined;
    const id = fields.id ?? current?.id ?? randomUUID();
    const next = { ...current, ...fields, id, discoveredAt: current?.discoveredAt ?? this.#now().toISOString() };
    this.#devices.set(id, next);
    return { ...next };
  }
}
