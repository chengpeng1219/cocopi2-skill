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
const hostKeyMode = process.env.COCOPI2_SSH_HOST_KEY_MODE ?? 'accept-new';
const strictHostKeyChecking = hostKeyMode === 'strict';
const allowNewHostKeys = hostKeyMode === 'accept-new';
const manager = new DeviceManager({ sshPassword: password, strictHostKeyChecking: hostKeyMode === 'strict', allowNewHostKeys: hostKeyMode === 'accept-new' });
const execSshProbe = process.env.SSH_PROBE_EXECUTABLE ?? 'ssh';
if (!['strict','accept-new','off'].includes(hostKeyMode)) throw new Error('Invalid SSH host-key mode');
const bindHost = process.env.HOST ?? '127.0.0.1';
if (password && !['127.0.0.1','::1','localhost'].includes(bindHost)) throw new Error('Refusing to serve a stored SSH password on a non-loopback interface.');
const MAX_BODY_BYTES = 64 * 1024;

async function readLocalSecret() {
  const key=process.env.COCOPI2_SECRET_KEY;
  if(!key||!process.env.COCOPI2_SECRET_FILE)return {password:''};
  try {const file=JSON.parse(await readFile(localSecretFile,'utf8'));const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(key).digest(),Buffer.from(file.iv,'base64'));decipher.setAuthTag(Buffer.from(file.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data,'base64')),decipher.final()]).toString('utf8'));}
  catch(error){if(error.code==='ENOENT')return {password:''};throw new Error(`Could not read encrypted SSH settings: ${error.message}`)}
}
async function saveLocalPassword(value){
  if(!process.env.COCOPI2_SECRET_KEY||!process.env.COCOPI2_SECRET_FILE)throw new Error('Start web using run-web.cmd to enable local encrypted password storage.');
  const key=createHash('sha256').update(process.env.COCOPI2_SECRET_KEY).digest();const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(JSON.stringify({password:value})),cipher.final()]);
  await mkdir(join(homedir(),'.cocopi2'),{recursive:true});await writeFile(localSecretFile,JSON.stringify({version:1,iv:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});return value;
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
  if (request.method === 'GET' && request.url === '/local-settings') return send(200,{sshPasswordConfigured:Boolean(password),hostKeyMode});
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
    if(typeof params.password!=='undefined')throw new TypeError('Do not send SSH passwords in HTTP request bodies.');
    if(request.url==='/local-settings'){
      if(typeof params.sshPassword!=='string'||params.sshPassword.length>256)throw new TypeError('sshPassword must be a string up to 256 characters');
      password=await saveLocalPassword(params.sshPassword);manager.updateSshSettings({sshPassword:password,strictHostKeyChecking,allowNewHostKeys});
      return send(200,{result:{sshPasswordConfigured:Boolean(password),hostKeyMode}});
    }
    const routes = {
      '/tools/test_ssh': async () => {
        const { host, username } = params;
        const port = params.port ?? 22;
        const timeoutMs = params.timeoutMs ?? 8000;
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