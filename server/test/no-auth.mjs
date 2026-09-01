import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const apiPort = 28768;
const bridgePort = 28767;
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    CHROME_API_PORT: String(apiPort),
    CHROME_MCP_PORT: String(bridgePort),
    UNIFIED_MCP_ALLOW_NO_AUTH: "true",
    UNIFIED_MCP_PSK: "intentionally-ignored-in-no-auth-mode",
    UNIFIED_MCP_KEEP_ALIVE: "1"
  },
  stdio: "ignore"
});

let socket;
try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok; }
    catch { return false; }
  });

  socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "request" && message.method === "tabs.list") {
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: [{ id: 42 }] }));
    }
  });
  socket.send(JSON.stringify({ type: "hello", role: "extension", browserId: "no-auth-browser", browserName: "No-auth browser" }));

  await waitFor(async () => {
    const health = await (await fetch(`http://127.0.0.1:${apiPort}/health`)).json();
    return health.authentication === "disabled" && health.browsers.length === 1;
  });

  const response = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, {});

  const toolResponse = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chrome_tabs_list", arguments: {} } })
  });
  assert.equal(toolResponse.status, 200);
  const toolResult = await toolResponse.json();
  assert.equal(JSON.parse(toolResult.result.content[0].text)[0].id, 42);
  process.stdout.write("no-auth integration test passed\n");
} finally {
  socket?.close();
  backend.kill();
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out");
}
