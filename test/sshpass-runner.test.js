import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device-manager.js';

test('configured password uses Python bridge and pipes secret through stdin only', async () => {
  const calls = [];
  const secret = 'school-password-not-in-argv';
  const manager = new DeviceManager({ sshPassword: secret, strictHostKeyChecking: false, runner: async (exe, args, options) => {
    calls.push({ exe, args, options });
    return { stdout: '', stderr: '' };
  } });
  await manager.connectDevice({ transport: 'wifi', host: '192.0.2.10', username: 'root' });
  assert.equal(calls[0].exe, process.env.PYTHON ?? 'python');
  assert.match(calls[0].args[0], /ssh_password_bridge\.py$/);
  assert.ok(!calls[0].args.join(' ').includes(secret));
  assert.deepEqual(calls[0].options.input, Buffer.concat([Buffer.from(`${Buffer.byteLength(secret)}\n`), Buffer.from(secret)]));
  assert.ok(calls[0].args.includes('false'));
});

test('password bridge retains strict host checking unless user opts in', async () => {
  const calls = [];
  const manager = new DeviceManager({ sshPassword: 'local-secret', runner: async (exe, args) => { calls.push(args); return { stdout: '' }; } });
  await manager.connectDevice({ transport: 'wifi', host: '192.0.2.11', username: 'root' });
  assert.ok(calls[0].includes('true'));
});
