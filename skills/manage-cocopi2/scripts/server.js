import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { DeviceManager } from './device-manager.js';
import { dashboard } from './page.js';

const manager = new DeviceManager();
const execSshProbe = process.env.SSH_PROBE_EXECUTABLE ?? 'ssh';
const MAX_BODY_BYTES = 64 * 1024;

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
    const routes = {
      '/tools/test_ssh': async () => {
        const { host, username } = params;
        const port = params.port ?? 22;
        const timeoutMs = params.timeoutMs ?? 8000;
        if (typeof host !== 'string' || !host.trim() || /[\s;&|`$<>]/.test(host)) throw new TypeError('host must be a hostname or IP address');
        if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(username)) throw new TypeError('username is required and must be a simple SSH account name');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535');
        if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new TypeError('timeoutMs must be between 500 and 60000');
        const args = ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,'-p',String(port),`${username}@${host}`,'true'];
        try {
          const { stdout, stderr } = await new Promise((resolve, reject) => {
            execFile(execSshProbe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, out, err) => error ? reject(error) : resolve({ stdout: out, stderr: err }));
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

server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => {
  console.log(`CocoPi2 device manager listening at http://${server.address().address}:${server.address().port}`);
});