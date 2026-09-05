import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthConfig } from "./config.ts";
import { tokenStorePath } from "./config.ts";
import { expandEnv, openInBrowser } from "./util.ts";

type StoredAuth = {
	tokens?: OAuthTokens & { obtained_at?: number };
	clientInformation?: OAuthClientInformationMixed;
	codeVerifier?: string;
	discovery?: OAuthDiscoveryState;
};

type TokenStore = Record<string, StoredAuth>;

function readStore(): TokenStore {
	const path = tokenStorePath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TokenStore;
	} catch {
		return {};
	}
}

function writeStore(store: TokenStore): void {
	const path = tokenStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function clearStoredAuth(key: string): void {
	const store = readStore();
	if (store[key]) {
		delete store[key];
		writeStore(store);
	}
}

export function hasStoredTokens(key: string): boolean {
	return Boolean(readStore()[key]?.tokens?.access_token);
}

export type AuthorizationPrompt = (info: { url: string }) => void;
type AuthorizationOptions = { authorizationStarted?: boolean };

/** Preferred loopback port for the OAuth redirect when none is configured. */
export const DEFAULT_CALLBACK_PORT = 19876;

/**
 * OAuthClientProvider that persists credentials to ~/.pi/agent/mcp-auth.json and
 * completes the authorization-code flow via a loopback HTTP listener.
 */
export class PiOAuthProvider implements OAuthClientProvider {
	private readonly key: string;
	private readonly cfg: OAuthConfig;
	private server?: Server;
	private port: number;
	/** True when the user pinned callbackPort in config (redirect URI may be pre-registered). */
	private readonly portIsExplicit: boolean;
	private pendingCode?: Promise<string>;
	private resolveCode?: (code: string) => void;
	private rejectCode?: (err: Error) => void;
	onAuthorizationUrl?: AuthorizationPrompt;

	constructor(key: string, cfg: OAuthConfig) {
		this.key = key;
		this.cfg = cfg;
		this.portIsExplicit = cfg.callbackPort !== undefined;
		this.port = cfg.callbackPort ?? DEFAULT_CALLBACK_PORT;
	}

	private get callbackPath(): string {
		return this.cfg.callbackPath ?? "/callback";
	}

	get redirectUrl(): string {
		return `http://127.0.0.1:${this.port}${this.callbackPath}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "pi coding agent (pi-mcp)",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.cfg.clientSecret ? "client_secret_post" : "none",
			scope: this.cfg.scope,
		};
	}

	private load(): StoredAuth {
		return readStore()[this.key] ?? {};
	}

	private save(patch: Partial<StoredAuth>): void {
		const store = readStore();
		store[this.key] = { ...(store[this.key] ?? {}), ...patch };
		writeStore(store);
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		if (this.cfg.clientId) {
			return {
				client_id: expandEnv(this.cfg.clientId),
				client_secret: this.cfg.clientSecret ? expandEnv(this.cfg.clientSecret) : undefined,
			} as OAuthClientInformationMixed;
		}
		return this.load().clientInformation;
	}

	saveClientInformation(info: OAuthClientInformationMixed): void {
		this.save({ clientInformation: info });
	}

	tokens(): OAuthTokens | undefined {
		return this.load().tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.save({ tokens: { ...tokens, obtained_at: Date.now() } });
	}

	saveCodeVerifier(verifier: string): void {
		this.save({ codeVerifier: verifier });
	}

	codeVerifier(): string {
		const v = this.load().codeVerifier;
		if (!v) throw new Error("No PKCE code verifier saved; restart the login flow");
		return v;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.save({ discovery: state });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.load().discovery;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		const store = readStore();
		const entry = store[this.key];
		if (!entry) return;
		if (scope === "all") {
			delete store[this.key];
		} else {
			if (scope === "client") delete entry.clientInformation;
			if (scope === "tokens") delete entry.tokens;
			if (scope === "verifier") delete entry.codeVerifier;
			if (scope === "discovery") delete entry.discovery;
		}
		writeStore(store);
	}

	/**
	 * Start the loopback listener. Must be called before connecting so the redirect URL
	 * (with its port) is known when client metadata is registered.
	 */
	async startCallbackServer(): Promise<void> {
		if (this.server) return;
		this.pendingCode = new Promise<string>((resolve, reject) => {
			this.resolveCode = resolve;
			this.rejectCode = reject;
		});
		// Avoid unhandled rejection noise if nobody awaits it
		this.pendingCode.catch(() => {});

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
			if (url.pathname !== this.callbackPath) {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			if (error || !code) {
				res.statusCode = 400;
				res.end(
					`<html><body style="font-family:sans-serif"><h2>Authorization failed</h2><p>${escapeHtml(error ?? "missing code")}: ${escapeHtml(url.searchParams.get("error_description") ?? "")}</p></body></html>`,
				);
				this.rejectCode?.(new Error(`OAuth authorization failed: ${error ?? "missing code"}`));
				return;
			}
			res.statusCode = 200;
			res.end(
				`<html><body style="font-family:sans-serif"><h2>Authorized</h2><p>You can close this window and return to pi.</p></body></html>`,
			);
			this.resolveCode?.(code);
		});

		try {
			await listen(server, this.port);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EADDRINUSE") throw err;
			if (this.portIsExplicit) {
				throw new Error(
					`OAuth callback port ${this.port} is already in use (is another pi instance running?). ` +
						`Close it or change "oauth.callbackPort" for this server.`,
				);
			}
			// Default port taken (likely another pi instance); fall back to an ephemeral port.
			await listen(server, 0);
		}
		const addr = server.address();
		if (addr && typeof addr === "object") this.port = addr.port;
		this.server = server;
	}

	/**
	 * Run the full interactive authorization flow for a server URL. Always releases
	 * the loopback listener when done, success or failure. Resume an existing redirect
	 * when the transport has already started authorization in response to a 401.
	 */
	async authorize(serverUrl: URL, options: AuthorizationOptions = {}): Promise<void> {
		return authorizeWith(this, serverUrl, auth, options);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		const url = authorizationUrl.toString();
		this.onAuthorizationUrl?.({ url });
		openInBrowser(url);
	}

	/** Wait for the browser to hit the callback with an authorization code. */
	async waitForAuthorizationCode(timeoutMs = 5 * 60 * 1000): Promise<string> {
		if (!this.pendingCode) throw new Error("Callback server not started");
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.pendingCode,
				new Promise<string>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Timed out waiting for OAuth authorization")), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	stopCallbackServer(): void {
		this.server?.close();
		this.server = undefined;
		this.pendingCode = undefined;
	}
}

/** Listen on 127.0.0.1 with proper error routing; exported for tests (port fallback cases). */
export function listen(server: Server, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("error", onError);
			reject(err);
		};
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
}

/**
 * Shared interactive authorization choreography: start the loopback listener, drive
 * redirect → code → token exchange via the given auth() implementation, always release
 * the listener. `authFn` is injectable so tests can exercise this routine against an
 * in-memory OAuth boundary (no browser, no user credentials) instead of a hand-synced copy.
 */
export async function authorizeWith(
	provider: PiOAuthProvider,
	serverUrl: URL,
	authFn: typeof auth = auth,
	{ authorizationStarted = false }: AuthorizationOptions = {},
): Promise<void> {
	await provider.startCallbackServer();
	try {
		// A second auth() call would overwrite the PKCE verifier for the pending code.
		const result = authorizationStarted ? "REDIRECT" : await authFn(provider, { serverUrl });
		if (result === "REDIRECT") {
			const authorizationCode = await provider.waitForAuthorizationCode();
			const completed = await authFn(provider, { serverUrl, authorizationCode });
			if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
		}
	} finally {
		provider.stopCallbackServer();
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
