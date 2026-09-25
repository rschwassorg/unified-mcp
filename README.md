# Unified MCP

Unified MCP is a local HTTP MCP server that publishes Chrome/CDP and filesystem tools through one endpoint.

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
