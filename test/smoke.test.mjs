// Smoke test: connect to a stdio server and an HTTP server via McpConnection, list and call tools.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(here, "pi-stub.mjs") } });
const { McpConnection } = await jiti.import(join(here, "../src/client.ts"));
const { expandEnv, sanitizeToolName } = await jiti.import(join(here, "../src/util.ts"));

let failures = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error("FAIL:", msg); } else console.log("ok:", msg); };

// util
process.env.PI_MCP_TEST = "xyz";
assert(expandEnv("a-$PI_MCP_TEST-${PI_MCP_TEST}-${NOPE:-dflt}-$$") === "a-xyz-xyz-dflt-$", "expandEnv");
assert(sanitizeToolName("my server/tool.name") === "my_server_tool_name", "sanitizeToolName");

// stdio
const stdio = new McpConnection("everything", {
  command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], excludeTools: ["trigger-*", "toggle-*"], connectTimeout: 120000,
});
await stdio.connect();
assert(stdio.status === "connected", "stdio connected");
assert(stdio.tools.length > 3, `stdio listed ${stdio.tools.length} tools`);
assert(!stdio.tools.some(t => t.name.startsWith("trigger-")), "excludeTools applied");
const r = await stdio.callTool("get-sum", { a: 2, b: 3 });
assert(r.content[0].text.includes("5"), "stdio get-sum tool call");
await stdio.close();

// http
const srv = spawn(process.execPath, [join(here, "http-server.mjs")], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: "8931", TEST_MCP_TOKEN: "secret123" } });
await new Promise(res => srv.stderr.once("data", res));
process.env.TEST_MCP_TOKEN = "secret123";
try {
  const bad = new McpConnection("bad", { url: "http://127.0.0.1:8931/mcp", token: "wrong" });
  await bad.connect().catch(() => {});
  assert(bad.status === "error", "http wrong token rejected");

  const http = new McpConnection("t", { url: "http://127.0.0.1:8931/mcp", token: "$TEST_MCP_TOKEN" });
  await http.connect();
  assert(http.status === "connected", "http connected with $ENV token");
  assert(http.tools.map(t => t.name).sort().join() === "add,echo", "http tools listed");
  const e = await http.callTool("echo", { message: "hi" });
  assert(e.content[0].text === "echo: hi", "http echo call");
  await http.close();
} finally {
  srv.kill();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
