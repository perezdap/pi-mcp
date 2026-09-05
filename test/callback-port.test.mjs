import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `pi-mcp-callback-test-${process.pid}`);

const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-stub.mjs', import.meta.url)),
} });
const { PiOAuthProvider, DEFAULT_CALLBACK_PORT, listen } = await jiti.import(new URL('../src/oauth.ts', import.meta.url).href);

// Occupy the default port to simulate another pi instance.
const blocker = createServer();
let blockedPort = DEFAULT_CALLBACK_PORT;
try {
  await listen(blocker, DEFAULT_CALLBACK_PORT);
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err;
  blockedPort = undefined; // already busy on this machine; still fine for the test
}

// Default (unpinned) port: falls back to an ephemeral port.
const fallback = new PiOAuthProvider('test|fallback', {});
await fallback.startCallbackServer();
const fallbackPort = Number(new URL(fallback.redirectUrl).port);
assert.ok(fallbackPort > 0 && fallbackPort !== DEFAULT_CALLBACK_PORT, 'falls back to an ephemeral port when default is busy');
fallback.stopCallbackServer();

// Explicit port: fails with a clear error instead of silently moving.
const busyPort = blockedPort ?? DEFAULT_CALLBACK_PORT;
const pinned = new PiOAuthProvider('test|pinned', { callbackPort: busyPort });
await assert.rejects(pinned.startCallbackServer(), /callback port \d+ is already in use.*callbackPort/);
pinned.stopCallbackServer();

// Free default port: uses it.
blocker.close();
await new Promise(resolve => blocker.once('close', resolve));
const probe = createServer();
let defaultFree = true;
try { await listen(probe, DEFAULT_CALLBACK_PORT); probe.close(); } catch { defaultFree = false; }
if (defaultFree) {
  const normal = new PiOAuthProvider('test|normal', {});
  await normal.startCallbackServer();
  assert.equal(normal.redirectUrl, `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`);
  normal.stopCallbackServer();
}

console.log('callback port fallback tests passed');
