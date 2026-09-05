// In-memory OAuth boundary: never opens a browser or accesses user credentials.
// Provides the auth() implementation injected into the real authorizeWith() routine.
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

// The stub provider delegates to the production authorizeWith() choreography from
// src/oauth.ts (via its own jiti instance with the pi alias), so the tests exercise
// the real routine instead of a hand-synced copy.
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-stub.mjs', import.meta.url)),
} });
const { authorizeWith } = await jiti.import(new URL('../src/oauth.ts', import.meta.url).href);

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
  async authorize(serverUrl, options) { return authorizeWith(this, serverUrl, auth, options); }
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
