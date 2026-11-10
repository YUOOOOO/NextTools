import assert from "node:assert/strict";
import { setImmediate as tick } from 'node:timers/promises';
import { cloudFixture } from './helpers/cloud-plugin-fixture.mjs';
import test from "node:test";
import { createConversationSync } from '../resources/plugins/pi.cloud-sync/client.cjs';
import { desktopDeviceName, desktopOsLabel } from "../electron/main/device-identity.mjs";

test("device identity shows the computer name and a readable OS", () => {
  assert.equal(desktopDeviceName("DESKTOP-ABC"), "DESKTOP-ABC");
  assert.equal(desktopDeviceName("  padded  "), "padded");
  assert.equal(desktopDeviceName(""), "Pilot");
  assert.equal(desktopDeviceName("   "), "Pilot");
  assert.equal(desktopDeviceName("x".repeat(80)).length, 60);

  // The Node platform id ("win32") must never reach the device list.
  assert.equal(desktopOsLabel("win32", "10.0.22631"), "Windows 11");
  assert.equal(desktopOsLabel("win32", "10.0.19045"), "Windows 10");
  assert.equal(desktopOsLabel("win32", ""), "Windows");
  assert.equal(desktopOsLabel("darwin", "23.0.0"), "macOS");
  assert.equal(desktopOsLabel("linux", "6.1.0"), "Linux");
  assert.equal(desktopOsLabel("freebsd", ""), "freebsd");
});

test('hub hello registers the persisted identity before advertising the computer', async () => {
  const fixture = cloudFixture();
  fixture.pi.remoteSessions.getDevice = async () => ({ id: 'desktop-identity', name: desktopDeviceName(), os: desktopOsLabel() });
  const sync = createConversationSync(fixture.pi);
  try {
    await sync.signIn({ baseUrl: 'http://127.0.0.1:8788', account: 'alice', password: 'secret1' });
    await tick();
    const hello = fixture.frames.find(frame => frame.type === 'hello');
    assert.ok(hello);
    assert.equal(hello.device.id, 'desktop-identity');
    assert.equal(hello.device.name, desktopDeviceName());
    assert.equal(hello.device.kind, 'computer');
    assert.equal(hello.device.os, desktopOsLabel());
    if (['win32', 'darwin', 'linux'].includes(process.platform)) assert.notEqual(hello.device.os, process.platform);
  } finally { await sync.signOut(); await sync.dispose(); }
});
