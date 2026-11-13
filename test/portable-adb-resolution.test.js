import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../skills/manage-cocopi2/scripts/device-manager.js';

const vendor = 'D:\\Program Files (x86)\\pcsuite\\adb_41\\adb.exe';
const noServer = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

test('portable skill discovers installed vendor adb when PATH lacks it and server is down', async () => {
  const calls = [];
  const manager = new DeviceManager({ adbSocketTransport: noServer, runner: async (exe, args) => {
    calls.push([exe, args]);
    if (args[0] === 'version' && exe !== vendor) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    if (args[0] === 'devices') return { stdout: 'List of devices attached\ncocopi2 device transport_id:1\n' };
    return { stdout: 'Android Debug Bridge version 1.0.41' };
  } });
  const found = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(found[0].endpoint, 'cocopi2');
  assert.equal(await manager.resolveAdbExecutable(), vendor);
  assert.ok(calls.some(([exe, args]) => exe === vendor && args[0] === 'devices'));
});

test('portable skill respects explicit adb path without vendor guessing', async () => {
  const calls = [];
  const path = 'C:\\user\\adb.exe';
  const manager = new DeviceManager({ adbExecutable: path, adbSocketTransport: noServer, runner: async (exe, args) => {
    calls.push(exe);
    if (args[0] === 'devices') return { stdout: 'List of devices attached\n' };
    return { stdout: 'ok' };
  } });
  await manager.discoverDevices({ transports: ['usb'] });
  assert.ok(calls.length > 0 && calls.every((exe) => exe === path));
});
