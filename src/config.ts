import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type OAuthConfig = {
	/** Pre-registered client id. If omitted, dynamic client registration is attempted. */
	clientId?: string;
	/** Client secret for confidential clients (supports $ENV). */
	clientSecret?: string;
	/** Space-separated scopes to request. */
	scope?: string;
	/** Local callback port. Default: 0 (random free port). */
	callbackPort?: number;
	/** Callback path. Default: /callback */
	callbackPath?: string;
};

export type ServerConfigBase = {
	/** Disable this server without removing it from the config. */
	disabled?: boolean;
	/** Only expose tools matching one of these globs (default: all). */
	includeTools?: string[];
	/** Hide tools matching one of these globs. */
	excludeTools?: string[];
	/** Prefix for pi tool names. Default: `<serverName>_`. Use "" for no prefix. */
	toolPrefix?: string;
	/** Per-call timeout in ms. Default: 60000. */
	timeout?: number;
	/** Connection/initialization timeout in ms. Default: 30000. */
	connectTimeout?: number;
	/** Connect at startup (default true). If false, connects lazily on first tool call or /mcp connect. */
	autoConnect?: boolean;
};

export type StdioServerConfig = ServerConfigBase & {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Extra environment variables. Values support $ENV expansion. */
	env?: Record<string, string>;
	cwd?: string;
};

export type HttpServerConfig = ServerConfigBase & {
	/** "http" = Streamable HTTP (default for url-based servers); "sse" = legacy SSE transport. */
	type?: "http" | "sse";
	url: string;
	/** Static headers sent on every request. Values support $ENV expansion. */
	headers?: Record<string, string>;
	/**
	 * Bearer token / API key shortcut. Sets `Authorization: Bearer <token>` unless `authHeader` is set.
	 * Supports $ENV expansion.
	 */
	token?: string;
	/** Header name for `token`. Default: Authorization. */
	authHeader?: string;
	/** Prefix for the token in `authHeader`. Default: "Bearer " when authHeader is Authorization, "" otherwise. */
	authPrefix?: string;
	/**
	 * OAuth configuration. Set to `true` for auto-discovery with dynamic client registration,
	 * or an object for pre-registered credentials/scopes.
	 */
	oauth?: boolean | OAuthConfig;
};

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export type McpConfig = {
	$schema?: string;
	mcpServers: Record<string, ServerConfig>;
	/** Default per-call timeout in ms applied when servers don't specify one. */
	defaultTimeout?: number;
	/** Add a `mcp_list_servers`-style meta tool? Default: false (the /mcp command covers it). */
	metaTools?: boolean;
};

export type LoadedConfig = {
	config: McpConfig;
	sources: string[];
};

export const CONFIG_FILENAME = "mcp.json";

export function globalConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILENAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

export function tokenStorePath(): string {
	return join(getAgentDir(), "mcp-auth.json");
}

export function isHttpServer(cfg: ServerConfig): cfg is HttpServerConfig {
	return typeof (cfg as HttpServerConfig).url === "string";
}

function readJson(path: string): unknown {
	const raw = readFileSync(path, "utf8");
	// Strip // and /* */ comments so users can annotate their config
	const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	return JSON.parse(stripped);
}

function normalize(input: unknown, source: string): McpConfig {
	if (!input || typeof input !== "object") throw new Error(`${source}: config must be a JSON object`);
	const obj = input as Record<string, unknown>;
	const servers = (obj.mcpServers ?? obj.servers ?? {}) as Record<string, ServerConfig>;
	if (typeof servers !== "object" || Array.isArray(servers)) {
		throw new Error(`${source}: "mcpServers" must be an object keyed by server name`);
	}
	for (const [name, cfg] of Object.entries(servers)) {
		if (!cfg || typeof cfg !== "object") throw new Error(`${source}: server "${name}" must be an object`);
		const c = cfg as Record<string, unknown>;
		if (typeof c.command !== "string" && typeof c.url !== "string") {
			throw new Error(`${source}: server "${name}" needs either "command" (stdio) or "url" (http/sse)`);
		}
	}
	return {
		mcpServers: servers,
		defaultTimeout: typeof obj.defaultTimeout === "number" ? obj.defaultTimeout : undefined,
		metaTools: typeof obj.metaTools === "boolean" ? obj.metaTools : undefined,
	};
}

/**
 * Load global config (~/.pi/agent/mcp.json) merged with project config (.pi/mcp.json).
 * Project servers override global servers with the same name. Project config is only
 * read when `includeProject` is true (i.e. the project is trusted).
 */
export function loadConfig(cwd: string, includeProject: boolean): LoadedConfig {
	const merged: McpConfig = { mcpServers: {} };
	const sources: string[] = [];

	const paths = [globalConfigPath()];
	if (includeProject) paths.push(projectConfigPath(cwd));

	for (const path of paths) {
		if (!existsSync(path)) continue;
		const cfg = normalize(readJson(path), path);
		sources.push(path);
		Object.assign(merged.mcpServers, cfg.mcpServers);
		if (cfg.defaultTimeout !== undefined) merged.defaultTimeout = cfg.defaultTimeout;
		if (cfg.metaTools !== undefined) merged.metaTools = cfg.metaTools;
	}

	return { config: merged, sources };
}

export const DEFAULT_CONFIG_TEMPLATE = `{
  // MCP servers exposed to pi as tools. Values support $ENV_VAR expansion.
  "mcpServers": {
    // stdio example:
    // "filesystem": {
    //   "command": "npx",
    //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    //   "env": { "DEBUG": "0" }
    // },

    // HTTP with API key:
    // "myapi": {
    //   "url": "https://mcp.example.com/mcp",
    //   "token": "$MYAPI_TOKEN"
    // },

    // HTTP with OAuth (browser login via /mcp login <name>):
    // "remote": {
    //   "url": "https://mcp.example.com/mcp",
    //   "oauth": true
    // }
  }
}
`;

export function ensureGlobalConfig(): string {
	const path = globalConfigPath();
	if (!existsSync(path)) {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(path, DEFAULT_CONFIG_TEMPLATE, "utf8");
	}
	return path;
}
