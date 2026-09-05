// In-memory OAuth boundary: never opens a browser or accesses user credentials.
export const state = { tokens: undefined, redirects: 0, exchanges: 0, listeners: 0, fail: false };
export function clearStoredAuth() { state.tokens = undefined; }
export class PiOAuthProvider {
  constructor() {}
  tokens() { return state.tokens; }
  async startCallbackServer() { if (!this.started) { this.started = true; state.listeners++; } }
  stopCallbackServer() { if (this.started) { this.started = false; state.listeners--; } }
  async waitForAuthorizationCode() { return 'test-code'; }
  // Mirrors PiOAuthProvider.authorize: drive the SDK auth() flow, always release the listener.
  async authorize(serverUrl) {
    await this.startCallbackServer();
    try {
      const result = await auth(this, { serverUrl });
      if (result === 'REDIRECT') {
        const authorizationCode = await this.waitForAuthorizationCode();
        const completed = await auth(this, { serverUrl, authorizationCode });
        if (completed !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete');
      }
    } finally {
      this.stopCallbackServer();
    }
  }
}
export class UnauthorizedError extends Error {}
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
