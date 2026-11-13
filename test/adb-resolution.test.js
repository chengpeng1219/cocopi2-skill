import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device-manager.js';

const KNOWN_ADB = 'D:\\Program Files (x86)\\pcsuite\\adb_41\\adb.exe';
const refused = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

function fakeRunner(used) {
  return async (exe, args) => {
    const name = String(exe);
    used.push([name, String(args?.[0])]);
    if (args?.[0] === 'version') {
      if (name !== KNOWN_ADB) { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; }
      return { stdout: 'Android Debug Utility version 1.0.41' };
    }
    if (args?.[0] === 'devices') return { stdout: 'List of devices attached\ncocopi2 device transport_id:1\n' };
    return { stdout: '' };
  };
}

test('falls back to a known adb install location when PATH and adb server are unavailable', async () => {
  const used = [];
  const manager = new DeviceManager({ adbSocketTransport: refused, runner: fakeRunner(used) });
  const found = await manager.discoverDevices({ transports: ['usb'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].endpoint, 'cocopi2');
  assert.ok(used.some(([exe, cmd]) => exe === KNOWN_ADB && cmd === 'devices'), JSON.stringify(used.slice(0, 12)));
});

test('explicit ADB_EXECUTABLE disables install-location guessing', async () => {
  const previous = process.env.ADB_EXECUTABLE;
  process.env.ADB_EXECUTABLE = 'C:\\my\\adb.exe';
  try {
    const used = [];
    const manager = new DeviceManager({
      adbSocketTransport: refused,
      runner: async (exe, args) => {
        const name = String(exe);
        used.push(name);
        if (args?.[0] === 'version' && name === 'C:\\my\\adb.exe') return { stdout: 'ok' };
        if (args?.[0] === 'devices') return { stdout: 'List of devices attached\n' };
        return { stdout: '' };
      },
    });
    await manager.discoverDevices({ transports: ['usb'] });
    assert.ok(used.includes('C:\\my\\adb.exe'));
    assert.ok(!used.includes(KNOWN_ADB), `must not probe install locations: ${used.join(', ')}`);
  } finally {
    if (previous === undefined) delete process.env.ADB_EXECUTABLE; else process.env.ADB_EXECUTABLE = previous;
  }
});