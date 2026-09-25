# Unified MCP

Unified MCP is a modular local MCP server. Independent modules publish their tools through one MCP endpoint.

It is intentionally local-first: the server binds to `127.0.0.1:18766` by default and direct loopback requests are accepted without an external authentication provider. There is no Cloudflare integration or GitHub Actions automation in this repository.

## Local endpoints

```text
http://127.0.0.1:18766/mcp
ws://127.0.0.1:18766/bridge
http://127.0.0.1:18766/health
```

The MCP stdio interface remains available for local clients.

## Install on Windows

Prerequisites are Node.js/npm and WinSW.

```powershell
cd C:\Users\rober\code\unified-mcp
git pull origin main

.\deploy\windows\install.ps1 `
  -WinSWExe "C:\ProgramData\UnifiedMcp\tools\winsw\winsw.exe"
```

The service builds the Node backend, binds it to loopback, creates the filesystem roots config if needed, and installs/restarts `UnifiedMcpBackend`.

For a foreground development process:

```powershell
.\deploy\windows\start-no-auth.ps1
```

## Chrome extension

Load `extension/` unpacked from `chrome://extensions`.

The default bridge URL is:

```text
ws://127.0.0.1:18766/bridge
```

Open the extension options to change the bridge URL, Browser ID, or browser name.

## MCP clients

HTTP MCP:

```text
http://127.0.0.1:18766/mcp
```

stdio example:

```json
{
  "mcpServers": {
    "unified-local": {
      "command": "node",
      "args": ["C:/Users/rober/code/unified-mcp/server/dist/index.js"]
    }
  }
}
```

## Browser tools

Unified MCP exposes Chrome tools including `chrome_browsers_list`, `chrome_status`, tab/page operations, and generic CDP attach/send/event operations.

## Filesystem tools

Filesystem roots are configured in:

```text
C:\ProgramData\UnifiedMcp\filesystem-roots.json
```

Available tools include `fs_roots_list`, `fs_list`, `fs_stat`, `fs_read_text`, `fs_write_text`, `fs_replace_text`, `fs_mkdir`, and `fs_move`.

Absolute paths, UNC paths, parent traversal, and resolved junction/symlink escapes are rejected. Writes can use an expected SHA-256 guard and modifying operations are audit logged.

## VibeTerm upstream

VibeTerm remains an optional internal MCP upstream at `http://127.0.0.1:47821/mcp`. Set `VIBETERM_API_TOKEN` if that upstream requires a token.

## Environment variables

```text
UNIFIED_MCP_PORT
UNIFIED_MCP_BIND_HOST
UNIFIED_MCP_ALLOW_NO_AUTH
UNIFIED_MCP_KEEP_ALIVE
UNIFIED_MCP_FS_CONFIG
UNIFIED_MCP_FS_MAX_FILE_BYTES
UNIFIED_MCP_FS_AUDIT_LOG
VIBETERM_MCP_URL
VIBETERM_API_TOKEN
VIBETERM_MCP_TIMEOUT_MS
VIBETERM_MCP_DISABLED
```

`CHROME_API_PORT` and `CHROME_BIND_HOST` remain accepted as compatibility fallbacks.


## Module architecture

First-party modules live under `server/src/modules/` and implement the small `McpModule` interface.

- `system`: filesystem tools plus approved command execution.
- `chrome-cdp`: Chrome browser and raw Chrome DevTools Protocol tools.

The core server only discovers the module that owns a requested tool and dispatches the call. New capability groups can be added as modules without adding their tool routing to the core server.

### Approved system commands

Copy `server/commands.example.json` to the machine configuration directory as `commands.json`, or set `UNIFIED_MCP_COMMANDS_CONFIG` to another file.

The system module exposes `cmd_list` and `cmd_run`. `cmd_run` only accepts command names declared in that configuration. Processes are spawned directly with `shell: false`; arbitrary shell command strings are not accepted. An optional `cwd` must be inside one of the configured filesystem roots.

Example MCP call:

```json
{
  "name": "cmd_run",
  "arguments": {
    "command": "git",
    "args": ["status"],
    "cwd": "C:\\Users\\rober\\code\\unified-mcp"
  }
}
```

Set `UNIFIED_MCP_COMMANDS_CONFIG` to configure a non-default command-list path.
