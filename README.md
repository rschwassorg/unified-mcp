# Unified MCP

Unified MCP is a local HTTP MCP server that publishes Chrome/CDP and filesystem tools through one Cloudflare-protected endpoint.

The local process intentionally does **not** terminate TLS. It listens on loopback HTTP only. Cloudflare Tunnel carries traffic to the machine, Cloudflare terminates public HTTPS/WSS, and Cloudflare Access provides authentication.

```text
MCP clients ---- HTTPS /mcp ----+
REST clients --- HTTPS /v1 -----+--> Cloudflare Access
Browser clients - WSS /bridge --+         |
                                          v
                                  Cloudflare Tunnel
                                          |
                                          v
                                  http://127.0.0.1:18766
                                          |
                                          +--> MCP / REST
                                          +--> WebSocket bridge
                                          +--> browser registry
                                          +--> Chrome CDP tools
                                          +--> filesystem tools
                                          +--> optional VibeTerm upstream
```

There is no nginx requirement, no local HTTPS certificate, and no Unified MCP PSK in the production design.

## Authentication model

Cloudflare Access is the authentication boundary for both MCP HTTP traffic and WebSocket upgrades.

When Access is configured, Unified MCP validates the signed `Cf-Access-Jwt-Assertion` that Cloudflare adds to authenticated origin requests. Validation checks the RS256 signature, issuer, application audience, and token lifetime against the Access team's signing keys.

The production paths are:

```text
https://unified-mcp.pentestsystem.com/mcp
    Cloudflare Access Managed OAuth -> HTTP MCP

wss://unified-mcp.pentestsystem.com/bridge
    Cloudflare Access browser session -> WebSocket bridge
```

For direct loopback diagnostics, the Windows service enables the loopback-only bypass. A request only qualifies when both the TCP peer and HTTP Host are loopback. A Tunnel request arrives over loopback but retains the public Host, so it still requires Cloudflare Access.

### Which Cloudflare auth mechanism to use

Use the Cloudflare mechanism that matches the client:

- **MCP clients, CLIs, SDKs, and agents:** enable **Managed OAuth** on the Access application. Standards-compatible clients can perform OAuth/PKCE without storing a Unified MCP secret.
- **Chrome/browser extensions:** authenticate interactively to the Access-protected hostname. Cloudflare sets the `CF_Authorization` application cookie; the browser then sends that session during the WebSocket handshake and Access injects `Cf-Access-Jwt-Assertion` at the origin.
- **Headless automation that can send custom HTTP headers:** use a Cloudflare Access **Service Token** with a Service Auth policy. Do not embed a service-token client secret in a distributed browser extension.

Browser WebSocket APIs cannot attach arbitrary authorization headers, so the extension uses the Access browser session rather than a static service token or PSK.

## Cloudflare configuration

### 1. Cloudflare Tunnel

Create one published application route:

```text
Hostname:
unified-mcp.pentestsystem.com

Service:
http://127.0.0.1:18766
```

Do not use `https://127.0.0.1` for the origin. Cloudflare handles public TLS and the local hop never leaves the machine.

The same route carries normal HTTP and WebSocket upgrade traffic. No separate WebSocket origin port is required.

If you manage DNS manually, the proxied CNAME points at the active Tunnel UUID:

```text
unified-mcp -> <TUNNEL-UUID>.cfargotunnel.com
```

### 2. Cloudflare Access

Create a **Self-hosted and private** Access application with a **public hostname** covering the entire Unified MCP hostname, not only `/mcp`:

```text
unified-mcp.pentestsystem.com
```

Do **not** create an RDP, browser-rendered RDP, or Infrastructure Access application for Unified MCP. Unified MCP is an HTTP/WebSocket service. A policy containing RDP connection rules such as `connection_rules.rdp` belongs to an RDP connection context and is the wrong policy shape for this service.

Recommended settings:

- Application type: **Self-hosted and private** -> **Add public hostname**.
- Allow policy restricted to the intended user identity.
- If the policy uses **Cloudflare Account Member**, select the **Cloudflare** identity provider for the application; that selector requires the Cloudflare identity provider.
- **Managed OAuth: enabled** so MCP/CLI clients can authenticate.
- Application cookie **SameSite: None** for cross-origin browser-extension WebSocket connections.
- Keep the application Audience (AUD) tag; the Windows service uses it to validate Access JWTs.
- After replacing an Access application, update `UNIFIED_MCP_CF_ACCESS_AUD` / `-CloudflareAccessAudience` to the new application's AUD before restarting the backend.

The origin does not implement its own OAuth authorization server. Cloudflare Access owns the OAuth flow.

## Windows service install

Prerequisites are Node.js/npm and a WinSW executable. nginx and OpenSSL are no longer required.

Run from an elevated PowerShell:

```powershell
cd C:\Users\rober\code\unified-mcp
git pull origin main

.\deploy\windows\install.ps1 `
  -WinSWExe "C:\ProgramData\UnifiedMcp\tools\winsw\winsw.exe" `
  -CloudflareAccessTeamDomain "https://bitter-surf-66e7.cloudflareaccess.com" `
  -CloudflareAccessAudience "<ACCESS_APP_AUD_TAG>"
```

The installer:

- builds the Node backend,
- binds it to `127.0.0.1:18766`,
- configures Cloudflare Access JWT validation,
- enables the safe direct-loopback diagnostic bypass,
- creates the filesystem roots config if needed,
- removes the legacy `UnifiedMcpNginx` Windows service if it exists,
- installs/restarts `UnifiedMcpBackend`.

The resulting local endpoints are:

```text
http://127.0.0.1:18766/mcp
ws://127.0.0.1:18766/bridge
http://127.0.0.1:18766/health
```

The public endpoints are:

```text
https://unified-mcp.pentestsystem.com/mcp
wss://unified-mcp.pentestsystem.com/bridge
https://unified-mcp.pentestsystem.com/health
```

To remove the Windows service while retaining configuration and logs:

```powershell
.\deploy\windows\uninstall.ps1
```

Older installs may still contain certificate or PSK files under `C:\ProgramData\UnifiedMcp`. They are not used by the new transport.

## Chrome extension

Load `extension/` unpacked from `chrome://extensions`.

The default bridge URL is:

```text
wss://unified-mcp.pentestsystem.com/bridge
```

The extension no longer stores or transmits a PSK.

Open **Extension options** and:

1. Confirm the bridge WebSocket URL.
2. Set a stable Browser ID and useful name.
3. Select **Sign in with Cloudflare Access**.
4. Complete the Access login in the opened browser tab.
5. Save and reconnect.

The sign-in tab visits the protected Unified MCP hostname so Cloudflare can issue the application authorization cookie. If a browser blocks the Access cookie as a third-party cookie, allow cookies for the Unified MCP hostname and the Cloudflare Access team domain.

## MCP clients

The MCP Streamable HTTP URL is:

```text
https://unified-mcp.pentestsystem.com/mcp
```

Enable **Managed OAuth** on the Access application and let compatible MCP clients perform their normal OAuth flow.

Unified MCP does not require a separate application password, PSK, or locally issued OAuth token.

The existing stdio MCP interface remains available for local compatibility:

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

Unified MCP currently exposes Chrome tools including:

```text
chrome_browsers_list
chrome_status
chrome_tabs_list
chrome_tab_open
chrome_tab_activate
chrome_tab_close
chrome_page_info
chrome_page_text
chrome_page_click
chrome_page_type
chrome_page_script
chrome_cdp_targets
chrome_cdp_protocol
chrome_cdp_attached
chrome_cdp_attach
chrome_cdp_detach
chrome_cdp_send
chrome_cdp_call
chrome_cdp_events
```

Every browser connection registers a stable `browserId`. When exactly one browser is connected it may be omitted from tool calls; when multiple browsers are online it is required.

## Filesystem tools

Filesystem roots are configured in:

```text
C:\ProgramData\UnifiedMcp\filesystem-roots.json
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

Available tools are:

```text
fs_roots_list
fs_list
fs_stat
fs_read_text
fs_write_text
fs_replace_text
fs_mkdir
fs_move
```

Absolute paths, UNC paths, parent traversal, and resolved junction/symlink escapes are rejected. Writes can use an expected SHA-256 guard and modifying operations are audit logged.

## VibeTerm upstream

VibeTerm remains an optional internal MCP upstream at:

```text
http://127.0.0.1:47821/mcp
```

Its authentication is independent from Unified MCP transport authentication. If VibeTerm requires a token, set `VIBETERM_API_TOKEN`; Unified MCP no longer reuses a browser or gateway PSK as the VibeTerm credential.

## Development modes

For an explicitly unauthenticated loopback development process:

```powershell
.\deploy\windows\start-no-auth.ps1
```

For a user-scoped process that validates Cloudflare Access:

```powershell
.\deploy\windows\start-authenticated.ps1 `
  -CloudflareAccessTeamDomain "https://bitter-surf-66e7.cloudflareaccess.com" `
  -CloudflareAccessAudience "<ACCESS_APP_AUD_TAG>"
```

Never publish `-AllowNoAuth` through a Tunnel.

## Relevant environment variables

```text
UNIFIED_MCP_PORT
UNIFIED_MCP_BIND_HOST
UNIFIED_MCP_ALLOW_NO_AUTH
UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH
UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN
UNIFIED_MCP_CF_ACCESS_AUD
UNIFIED_MCP_CF_ACCESS_CERTS_URL
UNIFIED_MCP_FS_CONFIG
UNIFIED_MCP_FS_MAX_FILE_BYTES
UNIFIED_MCP_FS_AUDIT_LOG
VIBETERM_MCP_URL
VIBETERM_API_TOKEN
VIBETERM_MCP_TIMEOUT_MS
VIBETERM_MCP_DISABLED
```

`CHROME_API_PORT` and `CHROME_BIND_HOST` remain accepted as compatibility fallbacks, but new deployments should use the `UNIFIED_MCP_*` names.
