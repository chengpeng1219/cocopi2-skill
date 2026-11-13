import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { DeviceManager } from './device-manager.js';
import { dashboard } from './page.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSshWithPassword } from './sshpass-runner.js';

const localSecretFile = process.env.COCOPI2_SECRET_FILE ?? join(homedir(), '.cocopi2', 'web-secret.json');
const stored = await readLocalSecret();
let password = process.env.COCOPI2_SSH_PASSWORD ?? stored.password ?? '';
const hostKeyMode = process.env.COCOPI2_SSH_HOST_KEY_MODE ?? (process.env.COCOPI2_SSH_STRICT_HOST_KEY_CHECKING === 'false' ? 'off' : 'accept-new');
const strictHostKeyChecking = hostKeyMode === 'strict';
const allowNewHostKeys = hostKeyMode === 'accept-new';
const acceptHostKeyMode = strictHostKeyChecking ? 'strict' : allowNewHostKeys ? 'accept-new' : 'off';
if (!['strict', 'accept-new', 'off'].includes(hostKeyMode)) throw new Error('COCOPI2_SSH_HOST_KEY_MODE must be strict, accept-new, or off');
const bindHost = process.env.HOST ?? '127.0.0.1';
if (password && !['127.0.0.1', '::1', 'localhost'].includes(bindHost)) throw new Error('Refusing to serve a stored SSH password on a non-loopback interface.');
const localOnly = ['127.0.0.1', '::1', 'localhost'].includes(bindHost);
const manager = new DeviceManager({ sshPassword: password, strictHostKeyChecking, allowNewHostKeys });
const execSshProbe = process.env.SSH_PROBE_EXECUTABLE ?? 'ssh';
const MAX_BODY_BYTES = 64 * 1024;


async function readLocalSecret() {
  const key = process.env.COCOPI2_SECRET_KEY;
  if (!key || !process.env.COCOPI2_SECRET_FILE) return { password: '' };
  try {
    const file = JSON.parse(await readFile(localSecretFile, 'utf8'));
    const keyBytes = createHash('sha256').update(key).digest();
    const iv = Buffer.from(file.iv, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', keyBytes, iv);
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(clear);
  } catch (error) {
    if (error.code === 'ENOENT') return { password: '' };
    throw new Error(`Could not read encrypted local SSH settings: ${error.message}`);
  }
}

async function saveLocalPassword(value) {
  if (process.env.COCOPI2_SSH_PASSWORD) throw new Error('The service uses COCOPI2_SSH_PASSWORD from its environment; unset it before storing an encrypted local password.');
  const key = process.env.COCOPI2_SECRET_KEY;
  if (!key || !process.env.COCOPI2_SECRET_FILE) throw new Error('Encrypted local password storage is not configured. Start the web page from run-web.ps1.');
  const keyBytes = createHash('sha256').update(key).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ password: value })), cipher.final()]);
  await mkdir(join(homedir(), '.cocopi2'), { recursive: true });
  await writeFile(localSecretFile, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  return value;
}

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(dashboard);
    return;
  }
  if (request.method === 'GET' && request.url === '/health') return send(200, { status: 'ok' });
  if (request.method === 'GET' && request.url === '/local-settings') return send(200, { sshPasswordConfigured: Boolean(password || process.env.COCOPI2_SSH_PASSWORD), strictHostKeyChecking: acceptHostKeyMode === 'strict', hostKeyMode: acceptHostKeyMode, localOnly });
  if (request.method === 'GET' && request.url === '/tools') {
    return send(200, { tools: ['discover_devices','list_devices','connect_device','disconnect_device','get_connection_status','get_device_info','test_ssh','run_command','list_programs','start_program','stop_program','program_log'] });
  }
  if (request.method === 'GET' && request.url === '/devices') return send(200, { devices: manager.listDevices() });
  if (request.method !== 'POST') return send(404, { error: 'not_found' });
  let body = '';
  try {
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return send(413, { error: 'request_too_large' });
    }
    const params = body ? JSON.parse(body) : {};
    if (typeof params.password !== 'undefined') throw new TypeError('Do not send SSH passwords in HTTP requests; use the local settings panel.');
    if (request.url === '/local-settings' && !Object.hasOwn(params, 'sshPassword')) return send(405, { error: 'method_not_allowed' });
    if (request.url === '/local-settings') {
      if (typeof params.sshPassword !== 'string' || params.sshPassword.length > 256) throw new TypeError('sshPassword must be a string up to 256 characters');
      const savedPassword = await saveLocalPassword(params.sshPassword);
      password = savedPassword;
      manager.updateSshSettings({ sshPassword: savedPassword, strictHostKeyChecking, allowNewHostKeys });
      return send(200, { result: { sshPasswordConfigured: Boolean(savedPassword), strictHostKeyChecking: acceptHostKeyMode === 'strict', hostKeyMode: acceptHostKeyMode } });
    }
    const routes = {
      '/tools/test_ssh': async () => {
        const { host, username } = params;
        const port = params.port ?? 22;
        const timeoutMs = params.timeoutMs ?? 8000;
        if (typeof params.password !== 'undefined') throw new TypeError('Do not send SSH passwords in HTTP requests; configure them locally through COCOPI2_SSH_PASSWORD.');
        if (typeof host !== 'string' || !host.trim() || /[\s;&|`$<>]/.test(host)) throw new TypeError('host must be a hostname or IP address');
        if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(username)) throw new TypeError('username is required and must be a simple SSH account name');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535');
        if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new TypeError('timeoutMs must be between 500 and 60000');
        try {
          const { stdout, stderr } = password
            ? await execSshWithPassword({ host, username, port, password, command: 'true', strictHostKeyChecking, timeoutMs })
            : await new Promise((resolve, reject) => {
                execFile(execSshProbe, ['-o','BatchMode=yes','-o',`StrictHostKeyChecking=${strictHostKeyChecking?'yes':'no'}`,'-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(port),`${username}@${host}`,'true'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, out, err) => error ? reject(error) : resolve({ stdout: out, stderr: err }));
              });
          return { ok: true, message: 'SSH command completed', stdout: stdout.trim(), stderr: stderr.trim() };
        } catch (error) {
          const code = error.code === 'ENOENT' ? 'ssh_not_found' : error.code === 'ETIMEDOUT' ? 'ssh_timeout' : 'ssh_failed';
          return { ok: false, code, message: String(error.message ?? error).slice(0, 500), stderr: String(error.stderr ?? '').slice(0, 500) };
        }
      },
      '/tools/discover_devices': () => manager.discoverDevices(params),
      '/tools/list_devices': () => manager.listDevices(params),
      '/tools/connect_device': () => manager.connectDevice(params),
      '/tools/disconnect_device': () => manager.disconnectDevice(params),
      '/tools/get_connection_status': () => manager.getConnectionStatus(params),
      '/tools/get_device_info': () => manager.getDeviceInfo(params),
      '/tools/run_command': () => manager.runCommand(params),
      '/tools/list_programs': () => manager.listPrograms(params),
      '/tools/start_program': () => manager.startProgram(params),
      '/tools/stop_program': () => manager.stopProgram(params),
      '/tools/program_log': () => manager.readProgramLog(params),
    };
    const action = routes[request.url];
    if (!action) return send(404, { error: 'not_found' });
    return send(200, { result: await action() });
  } catch (error) {
    const status = error instanceof SyntaxError || error instanceof TypeError ? 400 : 502;
    return send(status, { error: error.message });
  }
});

server.listen(Number(process.env.PORT ?? 8787), bindHost, () => {
  console.log(`CocoPi2 device manager listening at http://${server.address().address}:${server.address().port}`);
});