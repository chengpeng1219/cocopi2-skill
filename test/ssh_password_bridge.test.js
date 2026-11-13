import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('Python Paramiko 5 SSHClient.connect supports the bridge timeout keywords', async () => {
  const source = "import inspect, paramiko; s=inspect.signature(paramiko.SSHClient.connect); assert 'channel_timeout' in s.parameters and 'auth_timeout' in s.parameters";
  const child = spawn(process.env.PYTHON ?? 'python', ['-c', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',(c)=>stderr+=c);
  const [code]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status)=>resolve([status]));});
  assert.equal(code,0,stderr);
});

test('Python bridge syntax checks before use', async () => {
  const child = spawn(process.env.PYTHON ?? 'python', ['-m', 'py_compile', 'src/ssh_password_bridge.py'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve([status, signal])); });
  assert.equal(code, 0, stderr);
});
