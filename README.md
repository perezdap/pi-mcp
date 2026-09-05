# pi-mcp

A [pi](https://pi.dev) extension that connects to [MCP](https://modelcontextprotocol.io) servers and exposes their tools as native pi tools.

- **stdio** servers (spawned locally) and **Streamable HTTP** / legacy **SSE** servers
- **API keys / bearer tokens** via headers, with `$ENV_VAR` expansion
- **OAuth 2.1** (PKCE, dynamic client registration, token refresh) with a browser login flow — credentials persist in `~/.pi/agent/mcp-auth.json`
- Global (`~/.pi/agent/mcp.json`) and project-local (`.pi/mcp.json`) config
- Tool include/exclude filters, per-server name prefixes, timeouts, lazy connect
- Live `tools/list_changed` handling, `/mcp` command for status/login/reload

## Install

```bash
# from a local checkout
pi install /path/to/pi-mcp

# or from git
pi install git:github.com/perezdap/pi-mcp
```

For development: `pi -e ./index.ts`.

## Configuration

Run `/mcp config` inside pi to create `~/.pi/agent/mcp.json`, then edit it and run `/mcp reload`. A project-local `.pi/mcp.json` is merged on top (same server name wins) once the project is trusted. Comments (`//`, `/* */`) are allowed.

```jsonc
{
  "mcpServers": {
    // stdio: spawn a local process
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "SOME_KEY": "$SOME_KEY" },
      "cwd": "."
    },

    // HTTP with an API key (bearer token by default)
    "myapi": {
      "url": "https://mcp.example.com/mcp",
      "token": "$MYAPI_TOKEN"
    },

    // HTTP with a custom header instead of Authorization
    "otherapi": {
      "url": "https://other.example.com/mcp",
      "headers": { "X-Api-Key": "${OTHER_KEY}", "X-Org": "acme" }
    },

    // HTTP with OAuth — auto-discovery + dynamic client registration
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "oauth": true
    },

    // OAuth with a pre-registered client
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "oauth": { "clientId": "$GH_CLIENT_ID", "clientSecret": "$GH_CLIENT_SECRET", "scope": "repo read:user", "callbackPort": 19876 },
      "includeTools": ["search_*", "get_*"],
      "toolPrefix": "gh_"
    },

    // legacy SSE transport
    "legacy": { "type": "sse", "url": "https://legacy.example.com/sse", "disabled": true }
  },
  "defaultTimeout": 60000
}
```

### Server options

| Key | Applies to | Description |
|---|---|---|
| `command`, `args`, `env`, `cwd` | stdio | Process to spawn. Values support `$VAR`, `${VAR}`, `${VAR:-default}`. |
| `url` | http/sse | Server endpoint. `type` defaults to `"http"` (Streamable HTTP); set `"sse"` for legacy servers. |
| `headers` | http/sse | Static headers sent on every request. |
| `token` | http/sse | Shortcut for `Authorization: Bearer <token>`. Use `authHeader` / `authPrefix` to change the header name and prefix. |
| `oauth` | http/sse | `true` for discovery + dynamic registration, or `{ clientId, clientSecret, scope, callbackPort, callbackPath }`. |
| `includeTools`, `excludeTools` | all | Glob filters (`*`, `?`) on MCP tool names. |
| `toolPrefix` | all | Prefix for pi tool names. Default `<server>_`. `""` disables prefixing. |
| `timeout` | all | Per-call timeout in ms (default `defaultTimeout` or 60000). |
| `connectTimeout` | all | Connection/initialize timeout in ms (default 30000). |
| `autoConnect` | all | `false` to connect lazily on first tool call or `/mcp connect`. |
| `disabled` | all | Skip this server entirely. |

Tool names are sanitized to `[A-Za-z0-9_-]` and prefixed with the server name, e.g. server `github` + tool `search_issues` → `github_search_issues`.

## OAuth flow

When a server responds `401` and `oauth` is configured, the connection is marked **auth-required** at startup (no browser pop-ups unprompted). Run:

```
/mcp login <server>
```

Explicit `/mcp login` clears stored credentials and starts OAuth **before connecting**, even if the server accepts anonymous requests (for example, Context7). A normal connection can succeed anonymously; **connected** alone does not mean authenticated. Use `/mcp status` to check the stored-token indicator (`oauth✓` / `oauth✗`).

pi starts a loopback listener on `127.0.0.1:<callbackPort>` (default 19876; if that port is busy — e.g. another pi instance is running — and you have not set `callbackPort` explicitly, an ephemeral port is used instead), opens the authorization URL in your browser (also shown as a notification), exchanges the code with PKCE, stores the tokens, and connects. Tokens are refreshed automatically by the MCP SDK. `/mcp logout <server>` wipes stored credentials.

If you pre-register a client with your provider, use redirect URI `http://127.0.0.1:19876/callback` (or whatever `callbackPort`/`callbackPath` you configure).

## `/mcp` command

| Command | Description |
|---|---|
| `/mcp` or `/mcp status` | Connection status, tool counts, config file paths |
| `/mcp tools [server]` | List exposed pi tool names |
| `/mcp connect <server>` / `reconnect` | (Re)connect, running OAuth interactively if needed |
| `/mcp disconnect <server>` | Close connection and deactivate its tools |
| `/mcp login <server>` / `logout` | Force a fresh OAuth login / clear stored credentials |
| `/mcp reload` | Re-read config files and reconnect everything |
| `/mcp config` | Create the global config if missing and print paths |
| `/mcp logs <server>` | Show recent stderr from a stdio server |

The footer shows `mcp 2/3 (14 tools)` while servers are configured.

An `mcp_servers` tool is also registered so the model can list servers or reconnect one whose tools are missing.

## Development

```bash
npm install
npm run typecheck
npm test          # spawns @modelcontextprotocol/server-everything and a local HTTP test server
```

## License

MIT
