import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-stub.mjs', import.meta.url)),
} });
const { PiOAuthProvider } = await jiti.import(new URL('../src/oauth.ts', import.meta.url).href);
const { McpConnection } = await jiti.import(new URL('../src/client.ts', import.meta.url).href);

// Keep credentials in memory; exercise the real provider, SDK, and callback listener.
const credentials = new WeakMap();
function store(provider) {
  if (!credentials.has(provider)) credentials.set(provider, {});
  return credentials.get(provider);
}
for (const [reader, writer, field] of [
  ['tokens', 'saveTokens', 'tokens'],
  ['codeVerifier', 'saveCodeVerifier', 'verifier'],
  ['discoveryState', 'saveDiscoveryState', 'discovery'],
]) {
  PiOAuthProvider.prototype[reader] = function () { return store(this)[field]; };
  PiOAuthProvider.prototype[writer] = function (value) { store(this)[field] = value; };
}
PiOAuthProvider.prototype.invalidateCredentials = function () {};

const redirects = [];
let callbackRequest;
PiOAuthProvider.prototype.redirectToAuthorization = function (url) {
  redirects.push(url);
  // Complete the first browser flow, even if a bug starts a second one.
  if (redirects.length === 1) {
    callbackRequest = fetch(`${url.searchParams.get('redirect_uri')}?code=first-code`).then(r => r.text());
  }
};

let origin;
let exchanges = 0;
const server = createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
    json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    return;
  }
  if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
    json(200, {
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/token') {
    const params = new URLSearchParams(body);
    const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
    if (params.get('code') !== 'first-code' || challenge !== redirects[0].searchParams.get('code_challenge')) {
      json(400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
      return;
    }
    exchanges++;
    json(200, { access_token: 'challenge-token', token_type: 'Bearer' });
    return;
  }
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== 'Bearer challenge-token') {
    res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  const message = JSON.parse(body);
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'protected', version: '1' } }
    : { tools: [] };
  json(200, { jsonrpc: '2.0', id: message.id, result });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const conn = new McpConnection('challenge-test', {
  url: `${origin}/mcp`, oauth: { clientId: 'test-client', callbackPort: 0 },
});
try {
  await conn.connect(true);
  await callbackRequest;
  assert.equal(conn.status, 'connected');
  assert.equal(redirects.length, 1, 'a 401 challenge must open only one authorization flow');
  assert.equal(exchanges, 1, 'the first browser code must exchange with its original PKCE verifier');
  // A fresh listener can bind the callback port after successful authorization.
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(Number(new URL(redirects[0].searchParams.get('redirect_uri')).port), '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
  console.log('OAuth 401 challenge regression test passed');
} finally {
  await conn.close();
  await callbackRequest;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
