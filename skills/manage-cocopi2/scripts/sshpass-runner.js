import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function execSshWithPassword({ ssh = 'ssh', sshpass = process.env.SSHPASS_EXECUTABLE ?? 'sshpass', host, username, port = 22, password, command, strictHostKeyChecking = true, timeoutMs = 8000, runner = execFileAsync } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('password is required');
  if (typeof sshpass !== 'string' || !sshpass.trim()) throw new TypeError('sshpass executable is required');
  if (typeof host !== 'string' || !host.trim() || /[\s;&|`$<>]/.test(host)) throw new TypeError('host must be a hostname or IP address');
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(username)) throw new TypeError('username must be a simple SSH account name');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new TypeError('timeoutMs must be between 500 and 60000');
  if (typeof command !== 'string' || command.includes('\0')) throw new TypeError('command must be a string without null bytes');

  const sshArgs = ['-o', `BatchMode=${password ? 'no' : 'yes'}`, '-o', `StrictHostKeyChecking=${strictHostKeyChecking ? 'yes' : 'no'}`, '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, '-p', String(port), `${username}@${host}`, command];
  if (!password) return runner(ssh, sshArgs, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
  return runner(sshpass, ['-e', ssh, ...sshArgs], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, SSHPASS: password } });
}
