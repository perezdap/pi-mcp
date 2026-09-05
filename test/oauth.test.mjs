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
const { state } = await jiti.import(stub);
const { McpConnection } = await jiti.import(new URL('../src/client.ts', import.meta.url).href);
const headers = [];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
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
  await assert.rejects(conn.login(), /Connection in progress/);
  const pendingConnect = conn.connect();
  assert.equal(pendingConnect, pendingLogin, 'connect shares an in-flight login');
  release();
  await pendingLogin;
  state.gate = undefined;
  assert.equal(state.redirects, 3, 'concurrent calls do not start another flow');
  state.fail = true;
  await assert.rejects(conn.login(), /Authorization denied/);
  assert.equal(conn.status, 'error');
  assert.equal(conn.connected, false);
  assert.equal(state.listeners, 0, 'callback listener closes after failure');
  const noOAuth = new McpConnection('no-oauth', { url: conn.config.url });
  await assert.rejects(noOAuth.login(), /OAuth is not configured/);
  console.log('OAuth regression tests passed');
} finally {
  await conn.close();
  await new Promise(resolve => server.close(resolve));
}
