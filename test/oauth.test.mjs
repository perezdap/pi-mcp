import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const stub = fileURLToPath(new URL('./oauth-stub.mjs', import.meta.url));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-stub.mjs', import.meta.url)),
  './oauth.ts': stub,
  '@modelcontextprotocol/sdk/client/auth.js': stub,
} });
const { state, auth: stubAuth } = await jiti.import(stub);
const { McpConnection } = await jiti.import(new URL('../src/client.ts', import.meta.url).href);
// Real provider + real production routine, driven by the in-memory boundary.
const { authorizeWith: realAuthorizeWith, PiOAuthProvider: RealProvider } = await jiti.import(new URL('../src/oauth.ts', import.meta.url).href);
const headers = [];
// Gate for the local test HTTP server: while set (to a promise), requests wait on it.
const serverGate = { promise: undefined };
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (serverGate.promise) await serverGate.promise;
  headers.push(req.headers.authorization);
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'anonymous', version: '1' } }
    : { tools: [] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const conn = new McpConnection('optional-auth', {
  url: `http://127.0.0.1:${server.address().port}/mcp`, oauth: true,
});
try {
  await conn.connect();
  assert.equal(conn.status, 'connected');
  assert.equal(state.redirects, 0, 'normal anonymous connection does not force OAuth');
  assert.equal(state.listeners, 0, 'anonymous connection releases callback listener');
  await conn.login();
  assert.equal(state.redirects, 1, 'explicit login must authorize even without a 401');
  assert.equal(state.exchanges, 1);
  assert.equal(conn.status, 'connected');
  assert.equal(headers.at(-1), 'Bearer test-access-token');
  assert.equal(state.listeners, 0, 'callback listener closes after login');
  await conn.login();
  assert.equal(state.redirects, 2, 'repeat login forces fresh authorization');
  let release;
  state.gate = new Promise(resolve => { release = resolve; });
  const pendingLogin = conn.login();
  const queuedLogin = conn.login(); // serializes behind the in-flight login instead of rejecting
  const pendingConnect = conn.connect();
  assert.equal(pendingConnect, pendingLogin, 'connect shares an in-flight login');
  release();
  await pendingLogin;
  await queuedLogin;
  state.gate = undefined;
  assert.equal(state.redirects, 4, 'concurrent calls run one flow; the queued login runs after it');
  // login() while a plain connect() is in flight queues behind it rather than rejecting.
  let releaseConnect;
  serverGate.promise = new Promise(resolve => { releaseConnect = resolve; });
  const plainConnect = conn.connect();
  const queuedBehindConnect = conn.login();
  releaseConnect();
  await plainConnect;
  serverGate.promise = undefined;
  await queuedBehindConnect;
  assert.equal(state.redirects, 5, 'login queued behind a plain connect runs once it settles');
  assert.equal(conn.status, 'connected');
  state.fail = true;
  await assert.rejects(conn.login(), /Authorization denied/);
  assert.equal(conn.status, 'error');
  assert.equal(conn.connected, false);
  assert.equal(state.listeners, 0, 'callback listener closes after failure');
  state.fail = false;
  const noOAuth = new McpConnection('no-oauth', { url: conn.config.url });
  await assert.rejects(noOAuth.login(), /OAuth is not configured/);

  // The production authorizeWith() routine against the real provider: the loopback
  // listener starts for real and the authorization code is delivered over HTTP to it.
  const provider = new RealProvider('test|direct', {});
  provider.onAuthorizationUrl = () => {
    // The browser would land on the callback; hit it directly instead.
    fetch(`${provider.redirectUrl}?code=test-code`).then((r) => r.text()).catch(() => {});
  };
  const before = { redirects: state.redirects, exchanges: state.exchanges };
  await realAuthorizeWith(provider, new URL('http://127.0.0.1/mcp'), stubAuth);
  assert.equal(state.redirects, before.redirects + 1, 'authorizeWith drives redirect through the real provider');
  assert.equal(state.exchanges, before.exchanges + 1);
  assert.match(provider.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'loopback listener started on a real port');
  assert.equal(state.listeners, 0, 'real listener released after success');
  // Error-path callback: the listener rejects the pending code, authorizeWith still releases it.
  const failed = new RealProvider('test|failed', {});
  failed.onAuthorizationUrl = () => {
    fetch(`${failed.redirectUrl}?error=access_denied`).then((r) => r.text()).catch(() => {});
  };
  await assert.rejects(realAuthorizeWith(failed, new URL('http://127.0.0.1/mcp'), stubAuth), /OAuth authorization failed: access_denied/);
  assert.equal(state.listeners, 0, 'real listener released after failure');

  console.log('OAuth regression tests passed');
} finally {
  await conn.close();
  await new Promise(resolve => server.close(resolve));
}
