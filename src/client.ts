import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type HttpServerConfig, isHttpServer, type OAuthConfig, type ServerConfig } from "./config.ts";
import { clearStoredAuth, PiOAuthProvider } from "./oauth.ts";
import { errorMessage, expandEnv, expandEnvRecord, globMatch, withTimeout } from "./util.ts";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "auth-required" | "error";

export type ConnectionEvents = {
	onStatus?: (conn: McpConnection) => void;
	onToolsChanged?: (conn: McpConnection) => void;
	onAuthorizationUrl?: (conn: McpConnection, url: string) => void;
	onLog?: (conn: McpConnection, message: string) => void;
};

export class McpConnection {
	readonly name: string;
	readonly config: ServerConfig;
	status: ConnectionStatus = "disconnected";
	lastError?: string;
	tools: Tool[] = [];
	serverInfo?: { name: string; version?: string };
	private client?: Client;
	private transport?: Transport;
	private oauthProvider?: PiOAuthProvider;
	private stderrTail: string[] = [];
	private events: ConnectionEvents;
	private connecting?: Promise<void>;

	constructor(name: string, config: ServerConfig, events: ConnectionEvents = {}) {
		this.name = name;
		this.config = config;
		this.events = events;
	}

	get isHttp(): boolean {
		return isHttpServer(this.config);
	}

	get usesOAuth(): boolean {
		return isHttpServer(this.config) && Boolean(this.config.oauth);
	}

	get oauthKey(): string {
		return isHttpServer(this.config) ? `${this.name}|${this.config.url}` : this.name;
	}

	get connected(): boolean {
		return this.status === "connected" && this.client !== undefined;
	}

	private setStatus(status: ConnectionStatus, error?: string): void {
		this.status = status;
		this.lastError = error;
		this.events.onStatus?.(this);
	}

	private oauthConfig(): OAuthConfig {
		const cfg = (this.config as HttpServerConfig).oauth;
		// callbackPort is left undefined when not configured so PiOAuthProvider can fall back
		// to an ephemeral port if the default one is busy (e.g. another pi instance).
		return typeof cfg === "object" ? { ...cfg } : {};
	}

	private buildHttpHeaders(cfg: HttpServerConfig): Record<string, string> {
		const headers: Record<string, string> = { ...(expandEnvRecord(cfg.headers) ?? {}) };
		if (cfg.token) {
			const token = expandEnv(cfg.token);
			if (token) {
				const headerName = cfg.authHeader ?? "Authorization";
				const prefix = cfg.authPrefix ?? (headerName.toLowerCase() === "authorization" ? "Bearer " : "");
				headers[headerName] = `${prefix}${token}`;
			}
		}
		return headers;
	}

	private createTransport(): Transport {
		const cfg = this.config;
		if (isHttpServer(cfg)) {
			const url = new URL(expandEnv(cfg.url));
			const headers = this.buildHttpHeaders(cfg);
			const authProvider = this.oauthProvider;
			const requestInit: RequestInit = { headers };
			if (cfg.type === "sse") {
				return new SSEClientTransport(url, { authProvider, requestInit });
			}
			return new StreamableHTTPClientTransport(url, { authProvider, requestInit });
		}

		const env = { ...getDefaultEnvironment(), ...(expandEnvRecord(cfg.env) ?? {}) };
		const transport = new StdioClientTransport({
			command: expandEnv(cfg.command),
			args: (cfg.args ?? []).map((a) => expandEnv(a)),
			env,
			cwd: cfg.cwd ? expandEnv(cfg.cwd) : undefined,
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			for (const line of text.split(/\r?\n/)) {
				if (!line.trim()) continue;
				this.stderrTail.push(line);
				if (this.stderrTail.length > 40) this.stderrTail.shift();
				this.events.onLog?.(this, line);
			}
		});
		return transport;
	}

	/** Recent stderr output from a stdio server (for diagnostics). */
	get stderrLog(): string[] {
		return [...this.stderrTail];
	}

	/**
	 * Connect to the server. If `interactiveAuth` is true and the server requires OAuth,
	 * runs the browser login flow; otherwise marks the connection as auth-required.
	 */
	connect(interactiveAuth = false): Promise<void> {
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect(interactiveAuth).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	/** Explicit login must authorize even when the server accepts anonymous requests. */
	login(): Promise<void> {
		if (!this.usesOAuth) return Promise.reject(new Error("OAuth is not configured"));
		if (this.connecting) return Promise.reject(new Error("Connection in progress; retry login"));
		this.connecting = this.doConnect(true, true).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async doConnect(interactiveAuth: boolean, forceLogin = false): Promise<void> {
		await this.close();
		this.setStatus("connecting");
		const connectTimeout = this.config.connectTimeout ?? 30_000;

		if (forceLogin) clearStoredAuth(this.oauthKey);
		if (this.usesOAuth) {
			this.oauthProvider = new PiOAuthProvider(this.oauthKey, this.oauthConfig());
			this.oauthProvider.onAuthorizationUrl = ({ url }) => this.events.onAuthorizationUrl?.(this, url);
		}

		try {
			if (forceLogin) {
				const provider = this.oauthProvider!;
				await provider.startCallbackServer();
				const serverUrl = new URL(expandEnv((this.config as HttpServerConfig).url));
				const result = await auth(provider, { serverUrl });
				if (result === "REDIRECT") {
					const authorizationCode = await provider.waitForAuthorizationCode();
					const completed = await auth(provider, { serverUrl, authorizationCode });
					if (completed !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
				}
			}
			await withTimeout(this.attemptConnect(), connectTimeout, `Connecting to MCP server "${this.name}"`);
		} catch (err) {
			if (err instanceof UnauthorizedError && this.oauthProvider) {
				if (!interactiveAuth) {
					await this.teardown();
					this.setStatus("auth-required", "OAuth login required. Run /mcp login " + this.name);
					return;
				}
				try {
					await this.completeOAuth();
					await withTimeout(this.attemptConnect(), connectTimeout, `Connecting to MCP server "${this.name}"`);
				} catch (authErr) {
					await this.teardown();
					this.setStatus("error", `OAuth failed: ${errorMessage(authErr)}`);
					throw authErr;
				} finally {
					this.oauthProvider?.stopCallbackServer();
				}
			} else {
				await this.teardown();
				const detail = this.stderrTail.length ? `\n${this.stderrTail.slice(-5).join("\n")}` : "";
				this.setStatus("error", `${errorMessage(err)}${detail}`);
				throw err;
			}
		} finally {
			this.oauthProvider?.stopCallbackServer();
		}

		await this.refreshTools();
		this.setStatus("connected");
	}

	private async attemptConnect(): Promise<void> {
		if (this.oauthProvider && !this.oauthProvider.tokens()) {
			// Redirect URL must be known before dynamic client registration
			await this.oauthProvider.startCallbackServer();
		}
		const transport = this.createTransport();
		const client = new Client({ name: "pi-mcp", version: "0.1.0" }, { capabilities: {} });
		client.onerror = (err) => this.events.onLog?.(this, `client error: ${errorMessage(err)}`);
		client.onclose = () => {
			if (this.client === client) {
				this.client = undefined;
				this.transport = undefined;
				if (this.status === "connected") this.setStatus("disconnected", "Connection closed by server");
			}
		};
		try {
			await client.connect(transport);
		} catch (err) {
			await transport.close().catch(() => {});
			throw err;
		}
		this.client = client;
		this.transport = transport;
		const info = client.getServerVersion();
		if (info) this.serverInfo = { name: info.name, version: info.version };
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			try {
				await this.refreshTools();
				this.events.onToolsChanged?.(this);
			} catch (err) {
				this.events.onLog?.(this, `failed to refresh tools: ${errorMessage(err)}`);
			}
		});
	}

	private async completeOAuth(): Promise<void> {
		const provider = this.oauthProvider;
		if (!provider) throw new Error("No OAuth provider");
		await provider.startCallbackServer();
		const code = await provider.waitForAuthorizationCode();
		const cfg = this.config as HttpServerConfig;
		const url = new URL(expandEnv(cfg.url));
		// finishAuth exchanges the code for tokens via the provider; the transport itself is discarded.
		const transport =
			cfg.type === "sse"
				? new SSEClientTransport(url, { authProvider: provider })
				: new StreamableHTTPClientTransport(url, { authProvider: provider });
		await transport.finishAuth(code);
		await transport.close().catch(() => {});
	}

	async refreshTools(): Promise<Tool[]> {
		if (!this.client) throw new Error(`MCP server "${this.name}" is not connected`);
		const all: Tool[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.client.listTools(cursor ? { cursor } : undefined);
			all.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor);
		this.tools = all.filter((t) => this.toolAllowed(t.name));
		return this.tools;
	}

	private toolAllowed(name: string): boolean {
		const { includeTools, excludeTools } = this.config;
		if (includeTools?.length && !includeTools.some((g) => globMatch(g, name))) return false;
		if (excludeTools?.some((g) => globMatch(g, name))) return false;
		return true;
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, defaultTimeout?: number): Promise<CallToolResult> {
		if (!this.client) {
			await this.connect(false);
			if (!this.client) throw new Error(this.lastError ?? `MCP server "${this.name}" is not connected`);
		}
		const timeout = this.config.timeout ?? defaultTimeout ?? 60_000;
		const result = await this.client.callTool({ name, arguments: args }, undefined, {
			signal,
			timeout,
			resetTimeoutOnProgress: true,
		});
		return result as CallToolResult;
	}

	private async teardown(): Promise<void> {
		const client = this.client;
		const transport = this.transport;
		this.client = undefined;
		this.transport = undefined;
		try {
			await client?.close();
		} catch {
			// ignore
		}
		try {
			await transport?.close();
		} catch {
			// ignore
		}
	}

	async close(): Promise<void> {
		await this.teardown();
		this.oauthProvider?.stopCallbackServer();
		if (this.status !== "disconnected") this.setStatus("disconnected");
	}
}
