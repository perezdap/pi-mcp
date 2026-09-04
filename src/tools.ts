import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { McpConnection } from "./client.ts";
import { errorMessage, sanitizeToolName } from "./util.ts";

export type McpToolDetails = {
	server: string;
	tool: string;
	isError?: boolean;
	structuredContent?: unknown;
	truncated?: boolean;
	error?: string;
};

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function piToolName(conn: McpConnection, mcpToolName: string): string {
	const prefix = conn.config.toolPrefix ?? `${sanitizeToolName(conn.name)}_`;
	return sanitizeToolName(`${prefix}${mcpToolName}`);
}

/** Convert an MCP JSON-schema input to something TypeBox/pi accept. */
function toParameters(tool: Tool): TSchema {
	const schema = (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>;
	const cleaned: Record<string, unknown> = { ...schema };
	delete cleaned.$schema;
	if (cleaned.type !== "object") cleaned.type = "object";
	if (!cleaned.properties || typeof cleaned.properties !== "object") cleaned.properties = {};
	return cleaned as unknown as TSchema;
}

function convertResult(result: CallToolResult): { content: ContentBlock[]; truncated: boolean } {
	const content: ContentBlock[] = [];
	let truncated = false;
	const textParts: string[] = [];

	for (const block of result.content ?? []) {
		switch (block.type) {
			case "text":
				textParts.push(block.text);
				break;
			case "image":
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "audio":
				textParts.push(`[audio content: ${block.mimeType}, ${Math.round((block.data.length * 3) / 4 / 1024)}KB — not shown]`);
				break;
			case "resource_link":
				textParts.push(`[resource link] ${block.name ?? ""} ${block.uri}${block.description ? ` — ${block.description}` : ""}`.trim());
				break;
			case "resource": {
				const res = block.resource as { uri: string; mimeType?: string; text?: string; blob?: string };
				if (typeof res.text === "string") {
					textParts.push(`[resource ${res.uri}]\n${res.text}`);
				} else if (res.blob && res.mimeType?.startsWith("image/")) {
					content.push({ type: "image", data: res.blob, mimeType: res.mimeType });
				} else {
					textParts.push(`[binary resource ${res.uri} (${res.mimeType ?? "unknown"}) — not shown]`);
				}
				break;
			}
			default:
				textParts.push(JSON.stringify(block));
		}
	}

	if (textParts.length === 0 && result.structuredContent !== undefined) {
		textParts.push(JSON.stringify(result.structuredContent, null, 2));
	}

	if (textParts.length > 0) {
		const joined = textParts.join("\n");
		const t = truncateHead(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		let text = t.content;
		if (t.truncated) {
			truncated = true;
			text += `\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}).]`;
		}
		content.unshift({ type: "text", text });
	}

	if (content.length === 0) content.push({ type: "text", text: "(no content)" });
	return { content, truncated };
}

export function buildToolDefinition(
	pi: ExtensionAPI,
	conn: McpConnection,
	tool: Tool,
	defaultTimeout: number | undefined,
): ToolDefinition<TSchema, McpToolDetails> {
	const name = piToolName(conn, tool.name);
	const title = tool.annotations?.title ?? tool.title ?? tool.name;
	const description = (tool.description?.trim() || `MCP tool "${tool.name}" from server "${conn.name}"`) + `\n\n(MCP server: ${conn.name})`;

	return {
		name,
		label: `${conn.name}: ${title}`,
		description,
		parameters: toParameters(tool),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await conn.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal, defaultTimeout);
				const { content, truncated } = convertResult(result);
				const details: McpToolDetails = {
					server: conn.name,
					tool: tool.name,
					isError: result.isError === true,
					structuredContent: result.structuredContent,
					truncated,
				};
				if (result.isError) {
					const text = content.find((c) => c.type === "text");
					throw new Error(text && text.type === "text" ? text.text : `MCP tool "${tool.name}" reported an error`);
				}
				return { content, details };
			} catch (err) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: { server: conn.name, tool: tool.name } };
				}
				throw new Error(`[${conn.name}/${tool.name}] ${errorMessage(err)}`);
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(`${conn.name}/${tool.name}`));
			const argStr = JSON.stringify(args ?? {});
			if (argStr && argStr !== "{}") {
				const shown = argStr.length > 120 ? `${argStr.slice(0, 117)}...` : argStr;
				text += ` ${theme.fg("dim", shown)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
			const textBlock = result.content.find((c) => c.type === "text");
			const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
			const imageCount = result.content.filter((c) => c.type === "image").length;
			const lines = raw.split("\n");
			const preview = expanded ? lines : lines.slice(0, 8);
			let out = preview.join("\n");
			if (!expanded && lines.length > 8) out += theme.fg("dim", `\n... (${lines.length - 8} more lines)`);
			if (imageCount) out += theme.fg("dim", `\n[${imageCount} image(s)]`);
			return new Text(out || theme.fg("dim", "(no output)"), 0, 0);
		},
	};
}
