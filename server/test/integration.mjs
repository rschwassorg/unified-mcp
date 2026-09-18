import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const port = 28766;
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    UNIFIED_MCP_PORT: String(port),
    UNIFIED_MCP_ALLOW_NO_AUTH: "true",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    VIBETERM_MCP_DISABLED: "true"
  },
  stdio: "ignore"
});

const sockets = [];
try {
  await waitForHealth();

  const dashboard = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Browser fleet/);

  sockets.push(await browser("one", "First browser"), await browser("two", "Second browser"));
  await waitFor(async () => (await health()).browsers.length === 2);

  const result = await rpc("tools/call", { name: "chrome_status", arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status.browsers.map((item) => item.id).sort(), ["one", "two"]);
  assert.equal(status.port, port);
  assert.equal(status.authentication, "disabled");

  const conflict = await rpcRaw("tools/call", { name: "chrome_tabs_list", arguments: {} });
  assert.match(conflict.error.message, /browserId is required/);

  process.stdout.write("integration test passed\n");
} finally {
  for (const socket of sockets) socket.close();
  backend.kill();
}

async function browser(browserId, browserName) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "hello", role: "extension", browserId, browserName }));
  return socket;
}

async function health() {
  return (await fetch(`http://127.0.0.1:${port}/health`)).json();
}

async function waitForHealth() {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; }
    catch { return false; }
  });
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out");
}

async function rpc(method, params) {
  const value = await rpcRaw(method, params);
  assert.ok(value.result);
  return value.result;
}

async function rpcRaw(method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  assert.equal(response.status, 200);
  return response.json();
}
