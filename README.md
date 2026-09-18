# Unified MCP with multi-client Chrome CDP

This repository runs an extensible local MCP server behind an nginx HTTPS endpoint. Chrome CDP is its first tool family. Any number of Chrome profiles or remote browser machines can check in over authenticated WSS, and every Chrome tool accepts a `browserId` to route work to a specific browser.

```text
MCP clients  -- HTTPS /mcp ---+--> nginx :9443 --> Node backend (loopback only)
REST clients -- HTTPS /v1 ----+                         +--> VibeTerm MCP :47821
Chrome A ----- WSS /bridge ---+                         +--> browser registry
Chrome B ----- WSS /bridge ---+                         +--> Chrome CDP tools
```

nginx terminates TLS but does not execute MCP logic. On Windows, nginx and the Node backend therefore run as two automatic services. Both backend ports remain on `127.0.0.1`.

## Security model

- TLS is required on the exposed listener.
- Browsers authenticate in their first WSS message with a pre-shared key. The Chrome bridge keeps this PSK on `/bridge`.
- HTTP MCP/REST requests can be protected by Cloudflare Access Managed OAuth. The origin validates the `Cf-Access-Jwt-Assertion` JWT from Access and does not use the Chrome PSK for HTTP when Access validation is configured.
- The Windows installer generates a 256-bit Chrome PSK under `%ProgramData%\UnifiedMcp\secrets`, accessible only to SYSTEM and Administrators.
- The PSK is never written into nginx configuration, service XML, logs, or source control.
- The included certificate is self-signed. Import its public `.crt` into Trusted Root Certification Authorities on every client machine. Replace it with a trusted certificate before wider use.

Anyone holding the Chrome PSK can connect a browser bridge client. HTTP MCP/REST access is controlled independently by Cloudflare Access when configured. Expose only the minimum required filesystem roots and keep the public MCP endpoint behind the intended Cloudflare Tunnel and Access policy.

### Temporary local no-auth mode

For a loopback-only development installation, set
`UNIFIED_MCP_ALLOW_NO_AUTH=true`. This explicitly bypasses PSK checks for the
WSS bridge, MCP, and REST endpoints. The Windows installer accepts
`-AllowNoAuth` to set this service environment variable. Do not use this mode
on a listener reachable from another machine.

Without administrator access, run `deploy/windows/start-no-auth.ps1`. It binds
the browser bridge to `ws://127.0.0.1:18767` and the MCP/REST API to
`http://127.0.0.1:18768`. Reload the unpacked extension once so it migrates
from the legacy WSS service URL to this loopback-only endpoint.

For an authenticated user-scoped launch without installing Windows services,
run `deploy/windows/start-authenticated.ps1`. It creates a 256-bit PSK under
`%LOCALAPPDATA%\UnifiedMcp\secrets`, restricts that directory to the current
Windows identity, and starts the same loopback endpoints with bearer
authentication enabled. `ensure-user-psk.ps1 -CopyToClipboard` copies the PSK
without printing it so it can be entered into the extension or a trusted
reverse proxy. Direct local MCP calls whose connection and HTTP Host are both
loopback may omit the PSK; requests forwarded for a public hostname still
require it.

To start the authenticated server and its named Cloudflare Tunnel whenever the
current user signs in, run `deploy/windows/install-user-autostart.ps1`. The
scheduled tasks run with limited current-user privileges and restart failed
processes without embedding the PSK in task definitions or command lines.

## Windows service install

Prerequisites are Node.js/npm, nginx for Windows, a [WinSW](https://github.com/winsw/winsw/releases) executable, OpenSSL 1.1.1+, and an elevated PowerShell prompt.

```powershell
cd C:\path\to\chrome-cdp-bridge
.\deploy\windows\install.ps1 `
  -NginxRoot C:\tools\nginx `
  -WinSWExe C:\tools\WinSW-x64.exe `
  -PublicHost localhost `
  -CloudflareAccessTeamDomain "https://bitter-surf-66e7.cloudflareaccess.com" `
  -CloudflareAccessAudience "<ACCESS_APP_AUD_TAG>"
```

The installer builds the backend, creates the Chrome PSK and certificate if absent, validates nginx, creates `%ProgramData%\\UnifiedMcp\\filesystem-roots.json` if absent, and installs `UnifiedMcpBackend` followed by `UnifiedMcpNginx`. Pass the Cloudflare Access team domain and the Access application's Audience (AUD) tag to enable origin validation for HTTP MCP/REST requests. The default filesystem config exposes the installing user's `code` directory as a writable root named `code`; edit that file to narrow or expand agent access. To remove only the services while retaining configuration, certificates, secrets, and logs:

```powershell
.\deploy\windows\uninstall.ps1
```

## Configure each Chrome client

1. Open `chrome://extensions`, enable Developer mode, and load `extension/` unpacked.
2. Open the extension details and choose **Extension options**.
3. Set a unique stable Browser ID and useful name.
4. Set the endpoint, such as `wss://localhost:9443/bridge`.
5. Copy the PSK from the server as an Administrator, enter it in the options, and save.

For remote browser machines use a DNS name or IP covered by the certificate. The popup reports connection state without displaying the PSK.

## MCP configuration

The Streamable HTTP endpoint is `https://localhost:9443/mcp`. The Chrome bridge and HTTP MCP endpoint use separate authentication paths:

```text
/bridge -> 127.0.0.1:18765 -> Chrome PSK authentication
/mcp    -> 127.0.0.1:18766 -> Cloudflare Access Managed OAuth + origin JWT validation
/v1/*   -> 127.0.0.1:18766 -> Cloudflare Access JWT validation when exposed
```

For the Cloudflare MCP Portal deployment:

1. Keep the tunnel route for `unified-mcp.pentestsystem.com` pointed at the local nginx listener on port 9443.
2. Create a Cloudflare Access self-hosted/MCP application for `unified-mcp.pentestsystem.com/mcp*`. Do **not** include `/bridge` in that Access application.
3. Enable **Managed OAuth** on that Access application.
4. Allow the portal's upstream OAuth callback, normally `https://mcp.pentestsystem.com/servers-callback` (or Cloudflare's shared callback if you explicitly enabled it).
5. Copy the Access application's Audience (AUD) tag and configure the Windows service with `-CloudflareAccessTeamDomain` and `-CloudflareAccessAudience`.
6. Add `https://unified-mcp.pentestsystem.com/mcp` to the Cloudflare MCP Portal as an **OAuth** upstream server.

Cloudflare Access handles the OAuth discovery, DCR/authorization flow, token issuance, refresh, and policy enforcement at the edge. After a successful request reaches the origin, Access includes the user's signed identity JWT in `Cf-Access-Jwt-Assertion`. Unified MCP verifies that JWT's signature, issuer, audience, and expiration against the Access team's signing keys before processing MCP or REST requests. The Chrome PSK is not accepted as an HTTP credential while Cloudflare Access validation is configured.

The backend discovers and forwards VibeTerm's project and terminal tools from `http://127.0.0.1:47821/mcp`, so clients need only this one endpoint. `chrome_browsers_list` lists available IDs. When exactly one browser is connected, `browserId` may be omitted; with multiple browsers it is required.

Run `deploy/windows/configure-codex-env.ps1` after installation. It shares the gateway PSK with VibeTerm, trusts the TLS certificate in Windows and WSL, and maps `unified-mcp.local` to WSL's current Windows-host gateway. VibeTerm refreshes that WSL route whenever it starts its Codex app server.

```http
POST /mcp HTTP/1.1
Host: localhost:9443
Cf-Access-Jwt-Assertion: <ACCESS_JWT>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chrome_tabs_list","arguments":{"browserId":"work-laptop"}}}
```

The existing stdio MCP interface remains available for local compatibility:

```json
{
  "mcpServers": {
    "unified-local": {
      "command": "node",
      "args": ["C:/path/to/chrome-cdp-bridge/server/dist/index.js"]
    }
  }
}
```

## Filesystem tools

The gateway can expose selected local directories to MCP agents through named roots. Filesystem access is disabled until a valid roots configuration exists. The Windows service installer creates:

```text
%ProgramData%\UnifiedMcp\filesystem-roots.json
```

Example:

```json
{
  "roots": {
    "code": {
      "path": "C:\\Users\\rober\\code",
      "readOnly": false
    },
    "documents": {
      "path": "C:\\Users\\rober\\Documents",
      "readOnly": true
    }
  }
}
```

Available tools are `fs_roots_list`, `fs_list`, `fs_stat`, `fs_read_text`, `fs_write_text`, `fs_replace_text`, `fs_mkdir`, and `fs_move`. Agents address files using a root name plus a relative path; absolute paths, UNC paths, parent traversal, and resolved symlink/junction escapes are rejected. Reads and writes default to a 4 MiB maximum file size, directory listings are capped at 1,000 entries, writes can use an `expectedSha256` guard to prevent lost updates, and modifying operations are appended to `%ProgramData%\\UnifiedMcp\\logs\\filesystem-audit.log`.

`fs_replace_text` performs exact-match replacement and can require an expected occurrence count, which is safer for agent-driven edits than line-number based patches. Deletion is intentionally not exposed.

## REST and health

Open `https://localhost:9443/` for a live dashboard of connected browser clients, heartbeat times, and bridge metrics.

`GET /health` is intentionally unauthenticated and returns service/browser connection metadata. When Cloudflare Access validation is configured, `/mcp`, `/v1/*`, and `/openapi.json` require a valid `Cf-Access-Jwt-Assertion` from the configured Access application. Select a browser using `X-Browser-Id`, `?browserId=...`, or `browserId` in a JSON body.

The loopback defaults are port 18765 for browser WebSockets, 18766 for the Unified MCP/REST backend, and 47821 for VibeTerm. Relevant environment variables include `CHROME_MCP_PORT`, `CHROME_API_PORT`, `CHROME_BIND_HOST`, `CHROME_MCP_TIMEOUT_MS`, `UNIFIED_MCP_PSK`, `UNIFIED_MCP_PSK_FILE`, `UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN`, `UNIFIED_MCP_CF_ACCESS_AUD`, `UNIFIED_MCP_FS_CONFIG`, `UNIFIED_MCP_FS_MAX_FILE_BYTES`, `UNIFIED_MCP_FS_AUDIT_LOG`, `VIBETERM_MCP_URL`, `VIBETERM_MCP_TIMEOUT_MS`, and `VIBETERM_MCP_DISABLED`.

## Add more unified tools

Add local tool definitions to `localMcpTools` and dispatch them from `mcpCall` in `server/src/index.ts`. Additional Streamable HTTP tool families can use the upstream adapter in `server/src/mcp-upstream.ts`.
