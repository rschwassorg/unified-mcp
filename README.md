# Chrome CDP Bridge

A local Chrome extension plus Node server that exposes Chrome tabs and Chrome DevTools Protocol (CDP) through two interfaces:

- **HTTP API** with an OpenAPI 3.1 document, for API-aware clients.
- **MCP stdio server**, retained for existing MCP clients.

Both interfaces use the same Chrome extension and `chrome.debugger` connection, so only one debugger attachment is used per target.

## Architecture

```text
HTTP client or MCP client -> Node bridge -> local WebSocket -> Chrome extension -> chrome.debugger -> CDP
```

The WebSocket bridge binds to `127.0.0.1:18765` and the HTTP API binds to `127.0.0.1:18766` by default. Neither is exposed to the network.

## Start

1. Build and start the bridge:

   ```powershell
   cd server
   npm install
   npm run build
   npm start
   ```

2. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/`.

3. Open the extension popup and confirm it reports connected.

Use `CHROME_API_PORT` to change the HTTP API port. `CHROME_MCP_PORT` changes the extension WebSocket bridge port, but requires updating `SERVER_URL` in `extension/src/background.js` as well.

For an Alfred Docker worker running through WSL, keep the primary bridge on
loopback and configure `CHROME_AGENT_API_HOST` plus
`CHROME_AGENT_API_PORT` for a second HTTP listener on the specific Windows/WSL
gateway address. Configure the worker with that endpoint. Do not use
`0.0.0.0`: CDP control can read and operate the connected browser.

## HTTP API and OpenAPI

Fetch the complete API contract from:

```text
GET http://127.0.0.1:18766/openapi.json
```

Check availability with `GET /health`. When the extension is not connected, Chrome operations return `503` with an explanation.

Examples:

```powershell
# List Chrome tabs
Invoke-RestMethod http://127.0.0.1:18766/v1/tabs

# Read the current page title through CDP
Invoke-RestMethod -Method Post http://127.0.0.1:18766/v1/cdp/commands `
  -ContentType 'application/json' `
  -Body '{"tabId":123,"command":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}'
```

The main paths are:

- `/v1/tabs` and `/v1/pages/{tabId}/…` for common browser operations.
- `/v1/cdp/targets`, `/v1/cdp/attach`, `/v1/cdp/events`, and `/v1/cdp/detach` for CDP lifecycle operations.
- `POST /v1/cdp/commands` for any CDP command. It accepts `command`, `params`, and a `tabId`, `targetId`, or `extensionId`.
- `GET /v1/cdp/protocol` for the bundled official DevTools Protocol metadata.

The API does not enable CORS and binds only to loopback. CDP commands and page-script execution are powerful: do not rebind this service to a public interface without adding authentication and access controls.

## MCP client configuration

Existing MCP clients can continue to use:

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "node",
      "args": ["C:/Users/rober/tools/vibecoder/chrome-mcp/server/dist/index.js"]
    }
  }
}
```

MCP tools and HTTP routes operate against the same live Chrome bridge.
