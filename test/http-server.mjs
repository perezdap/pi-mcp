// Minimal stateless Streamable HTTP MCP server requiring a bearer token, for testing.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TOKEN = process.env.TEST_MCP_TOKEN ?? "secret123";
const PORT = Number(process.env.PORT ?? 8931);

function makeServer() {
	const server = new McpServer({ name: "test-http", version: "0.0.1" });
	server.registerTool("echo", { description: "Echo a message back", inputSchema: { message: z.string() } }, async ({ message }) => ({
		content: [{ type: "text", text: `echo: ${message}` }],
	}));
	server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
		content: [{ type: "text", text: String(a + b) }],
	}));
	return server;
}

createServer(async (req, res) => {
	if (req.headers.authorization !== `Bearer ${TOKEN}`) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	// Stateless mode: fresh server + transport per request
	const server = makeServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		transport.close();
		server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}).listen(PORT, () => console.error(`test MCP server on http://127.0.0.1:${PORT}/mcp (token: ${TOKEN})`));
