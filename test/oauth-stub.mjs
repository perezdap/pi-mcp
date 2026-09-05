// In-memory OAuth boundary: never opens a browser or accesses user credentials.
// Provides the auth() implementation injected into the real authorizeWith() routine.
export const state = { tokens: undefined, redirects: 0, exchanges: 0, listeners: 0, fail: false, gate: undefined };
export function clearStoredAuth() { state.tokens = undefined; }
export class UnauthorizedError extends Error {}
// Minimal provider test double: no browser, no credentials, in-memory tokens,
// and a code delivered without a loopback listener.
export class PiOAuthProvider {
  constructor() {}
  tokens() { return state.tokens; }
  async startCallbackServer() { if (!this.started) { this.started = true; state.listeners++; } }
  stopCallbackServer() { if (this.started) { this.started = false; state.listeners--; } }
  async waitForAuthorizationCode() { return 'test-code'; }
  async authorize(serverUrl) { return authorizeWith(this, serverUrl, auth); }
}
export async function auth(provider, options) {
  if (state.gate) await state.gate;
  if (state.fail) throw new Error('Authorization denied');
  if (!options.authorizationCode) {
    state.redirects++;
    provider.onAuthorizationUrl?.({ url: 'https://example.invalid/authorize' });
    return 'REDIRECT';
  }
  state.exchanges++;
  state.tokens = { access_token: 'test-access-token', token_type: 'Bearer' };
  return 'AUTHORIZED';
}
// Same choreography as the production authorizeWith(), minus the loopback listener
// (the stub provider delivers the code without one).
export async function authorizeWith(provider, serverUrl, authFn) {
  await provider.startCallbackServer();
  try {
    const result = await authFn(provider, { serverUrl });
    if (result === 'REDIRECT') {
      const authorizationCode = await provider.waitForAuthorizationCode();
      const completed = await authFn(provider, { serverUrl, authorizationCode });
      if (completed !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete');
    }
  } finally {
    provider.stopCallbackServer();
  }
}
