import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { McpConnection } from "./src/client.ts";
import { ensureGlobalConfig, globalConfigPath, loadConfig, type McpConfig, projectConfigPath } from "./src/config.ts";
import { clearStoredAuth, hasStoredTokens } from "./src/oauth.ts";
import { buildToolDefinition, piToolName } from "./src/tools.ts";
import { errorMessage } from "./src/util.ts";

const STATUS_KEY = "mcp";

export default function (pi: ExtensionAPI) {
	const connections = new Map<string, McpConnection>();
	/** pi tool names registered per server, so we can deactivate stale ones. */
	const registeredTools = new Map<string, Set<string>>();
	let config: McpConfig = { mcpServers: {} };
	let configSources: string[] = [];
	let uiCtx: ExtensionContext | undefined;
	let started = false;

	// ---------- helpers ----------

	function notify(msg: string, level: "info" | "warning" | "error" = "info") {
		if (uiCtx?.hasUI) uiCtx.ui.notify(msg, level);
	}

	function updateStatus() {
		if (!uiCtx?.hasUI) return;
		const conns = [...connections.values()];
		if (conns.length === 0) {
			uiCtx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const connected = conns.filter((c) => c.status === "connected");
		const toolCount = connected.reduce((n, c) => n + c.tools.length, 0);
		const problems = conns.filter((c) => c.status === "error" || c.status === "auth-required").length;
		let text = `mcp ${connected.length}/${conns.length} (${toolCount} tools)`;
		if (problems) text += ` ⚠${problems}`;
		uiCtx.ui.setStatus(STATUS_KEY, text);
	}

	function syncTools(conn: McpConnection) {
		const previous = registeredTools.get(conn.name) ?? new Set<string>();
		const current = new Set<string>();

		for (const tool of conn.tools) {
			const def = buildToolDefinition(pi, conn, tool, config.defaultTimeout);
			pi.registerTool(def);
			current.add(def.name);
		}
		registeredTools.set(conn.name, current);

		// Deactivate tools that disappeared
		const stale = [...previous].filter((n) => !current.has(n));
		if (stale.length) {
			const active = pi.getActiveTools().filter((n) => !stale.includes(n));
			pi.setActiveTools(active);
		}
		updateStatus();
	}

	function deactivateServerTools(name: string) {
		const names = registeredTools.get(name);
		if (!names?.size) return;
		pi.setActiveTools(pi.getActiveTools().filter((n) => !names.has(n)));
		registeredTools.delete(name);
	}

	function createConnection(name: string, cfg: McpConfig["mcpServers"][string]): McpConnection {
		return new McpConnection(name, cfg, {
			onStatus: () => updateStatus(),
			onToolsChanged: (c) => {
				syncTools(c);
				notify(`MCP "${c.name}": tool list updated (${c.tools.length} tools)`);
			},
			onAuthorizationUrl: (c, url) => {
				notify(`MCP "${c.name}": opening browser for login. If it doesn't open, visit:\n${url}`, "info");
			},
		});
	}

	async function connectServer(conn: McpConnection, interactive: boolean, quiet = false): Promise<boolean> {
		try {
			await conn.connect(interactive);
			if (conn.status === "connected") {
				syncTools(conn);
				if (!quiet) notify(`MCP "${conn.name}": connected, ${conn.tools.length} tool(s)`);
				return true;
			}
			if (conn.status === "auth-required") {
				notify(`MCP "${conn.name}": login required — run /mcp login ${conn.name}`, "warning");
			}
			return false;
		} catch (err) {
			notify(`MCP "${conn.name}": ${errorMessage(err).split("\n")[0]}`, "error");
			return false;
		}
	}

	async function closeAll() {
		await Promise.allSettled([...connections.values()].map((c) => c.close()));
		for (const name of [...registeredTools.keys()]) deactivateServerTools(name);
		connections.clear();
		updateStatus();
	}

	async function startAll(ctx: ExtensionContext) {
		let loaded;
		try {
			loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		} catch (err) {
			notify(`MCP config error: ${errorMessage(err)}`, "error");
			return;
		}
		config = loaded.config;
		configSources = loaded.sources;

		const entries = Object.entries(config.mcpServers).filter(([, cfg]) => !cfg.disabled);
		for (const [name, cfg] of entries) connections.set(name, createConnection(name, cfg));
		updateStatus();

		await Promise.allSettled(
			entries.filter(([, cfg]) => cfg.autoConnect !== false).map(([name]) => connectServer(connections.get(name)!, false, true)),
		);

		const connected = [...connections.values()].filter((c) => c.status === "connected");
		const tools = connected.reduce((n, c) => n + c.tools.length, 0);
		if (connections.size) {
			notify(`MCP: ${connected.length}/${connections.size} server(s) connected, ${tools} tool(s)`);
		}
	}

	async function reload(ctx: ExtensionContext) {
		await closeAll();
		await startAll(ctx);
	}

	// ---------- lifecycle ----------

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		if (started) await closeAll();
		started = true;
		await startAll(ctx);
	});

	pi.on("session_shutdown", async () => {
		started = false;
		await closeAll();
	});

	// ---------- /mcp command ----------

	const SUBCOMMANDS = ["status", "list", "tools", "connect", "disconnect", "reconnect", "login", "logout", "reload", "config", "logs"];

	pi.registerCommand("mcp", {
		description: "Manage MCP servers: status | tools [name] | connect|disconnect|reconnect <name> | login|logout <name> | reload | config | logs <name>",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
				return items.length ? items : null;
			}
			const names = [...connections.keys()].filter((n) => n.startsWith(parts[1] ?? ""));
			const items = names.map((n) => ({ value: `${parts[0]} ${n}`, label: n }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const [sub = "status", target] = args.trim().split(/\s+/).filter(Boolean);

			const pick = async (): Promise<McpConnection | undefined> => {
				if (target) {
					const c = connections.get(target);
					if (!c) ctx.ui.notify(`Unknown MCP server "${target}". Known: ${[...connections.keys()].join(", ") || "(none)"}`, "error");
					return c;
				}
				const names = [...connections.keys()];
				if (names.length === 0) {
					ctx.ui.notify("No MCP servers configured. Run /mcp config", "warning");
					return undefined;
				}
				const choice = await ctx.ui.select("MCP server:", names);
				return choice ? connections.get(choice) : undefined;
			};

			switch (sub) {
				case "status":
				case "list": {
					if (connections.size === 0) {
						ctx.ui.notify(`No MCP servers configured.\nGlobal config: ${globalConfigPath()}\nProject config: ${projectConfigPath(ctx.cwd)}\nRun /mcp config to create one.`, "info");
						return;
					}
					const lines = [...connections.values()].map((c) => {
						const kind = c.isHttp ? (c.config as { type?: string }).type ?? "http" : "stdio";
						const auth = c.usesOAuth ? (hasStoredTokens(c.oauthKey) ? " oauth✓" : " oauth✗") : "";
						const err = c.lastError && c.status !== "connected" ? ` — ${c.lastError.split("\n")[0]}` : "";
						return `${statusIcon(c.status)} ${c.name} [${kind}${auth}] ${c.status}, ${c.tools.length} tools${err}`;
					});
					lines.push("", `Config: ${configSources.join(", ") || "(none found)"}`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "tools": {
					const conns = target ? [connections.get(target)].filter(Boolean) as McpConnection[] : [...connections.values()];
					if (target && conns.length === 0) {
						ctx.ui.notify(`Unknown MCP server "${target}"`, "error");
						return;
					}
					const lines: string[] = [];
					for (const c of conns) {
						lines.push(`${statusIcon(c.status)} ${c.name} (${c.tools.length}):`);
						for (const t of c.tools) {
							const desc = (t.description ?? "").split("\n")[0].slice(0, 80);
							lines.push(`   ${piToolName(c, t.name)}${desc ? ` — ${desc}` : ""}`);
						}
					}
					ctx.ui.notify(lines.join("\n") || "No tools", "info");
					return;
				}
				case "connect":
				case "reconnect": {
					const c = await pick();
					if (!c) return;
					ctx.ui.notify(`Connecting to "${c.name}"...`, "info");
					await connectServer(c, true);
					return;
				}
				case "disconnect": {
					const c = await pick();
					if (!c) return;
					await c.close();
					deactivateServerTools(c.name);
					updateStatus();
					ctx.ui.notify(`Disconnected "${c.name}"`, "info");
					return;
				}
				case "login": {
					const c = await pick();
					if (!c) return;
					if (!c.usesOAuth) {
						ctx.ui.notify(`"${c.name}" does not use OAuth. Set "oauth": true in its config.`, "warning");
						return;
					}
					clearStoredAuth(c.oauthKey);
					ctx.ui.notify(`Starting OAuth login for "${c.name}" — check your browser.`, "info");
					await connectServer(c, true);
					return;
				}
				case "logout": {
					const c = await pick();
					if (!c) return;
					clearStoredAuth(c.oauthKey);
					await c.close();
					deactivateServerTools(c.name);
					updateStatus();
					ctx.ui.notify(`Cleared stored credentials for "${c.name}"`, "info");
					return;
				}
				case "reload": {
					ctx.ui.notify("Reloading MCP config...", "info");
					await reload(ctx);
					return;
				}
				case "config": {
					const path = ensureGlobalConfig();
					const lines = [`Global config: ${path}`, `Project config: ${projectConfigPath(ctx.cwd)}${ctx.isProjectTrusted() ? "" : " (project not trusted — ignored)"}`, "", "Edit the file, then run /mcp reload."];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "logs": {
					const c = await pick();
					if (!c) return;
					const log = c.stderrLog;
					ctx.ui.notify(log.length ? log.join("\n") : `No stderr output from "${c.name}"${c.lastError ? `\nLast error: ${c.lastError}` : ""}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: ${SUBCOMMANDS.join(", ")}`, "error");
			}
		},
	});

	// ---------- optional meta tool ----------

	pi.registerTool({
		name: "mcp_servers",
		label: "MCP Servers",
		description: "List configured MCP servers, their connection status, and their available tools. Use action \"connect\" to (re)connect a server whose tools are not currently available.",
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["list", "connect"] as const)),
			server: Type.Optional(Type.String({ description: "Server name (required for connect)" })),
		}),
		async execute(_id, params) {
			if (params.action === "connect") {
				const c = params.server ? connections.get(params.server) : undefined;
				if (!c) throw new Error(`Unknown MCP server "${params.server ?? ""}"`);
				const ok = await connectServer(c, false);
				return {
					content: [{ type: "text", text: ok ? `Connected "${c.name}" with ${c.tools.length} tools: ${c.tools.map((t) => piToolName(c, t.name)).join(", ")}` : `Could not connect "${c.name}": ${c.lastError ?? "unknown error"}` }],
					details: {},
				};
			}
			const lines = [...connections.values()].map((c) => {
				const tools = c.tools.map((t) => piToolName(c, t.name)).join(", ");
				return `${c.name}: ${c.status}${c.lastError && c.status !== "connected" ? ` (${c.lastError.split("\n")[0]})` : ""}${tools ? `\n  tools: ${tools}` : ""}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") || "No MCP servers configured." }], details: {} };
		},
	});
}

function statusIcon(status: McpConnection["status"]): string {
	switch (status) {
		case "connected":
			return "●";
		case "connecting":
			return "◌";
		case "auth-required":
			return "🔒";
		case "error":
			return "✗";
		default:
			return "○";
	}
}
