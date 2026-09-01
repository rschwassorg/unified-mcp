import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const psk = randomBytes(32).toString("base64url");
const apiPort = 28766;
const bridgePort = 28765;
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, CHROME_API_PORT: String(apiPort), CHROME_MCP_PORT: String(bridgePort), UNIFIED_MCP_PSK: psk, UNIFIED_MCP_ALLOW_NO_AUTH: "false", UNIFIED_MCP_KEEP_ALIVE: "1" },
  stdio: "ignore"
});

const sockets = [];
try {
  await waitForHealth();
  const dashboard = await fetch(`http://127.0.0.1:${apiPort}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Browser fleet/);
  sockets.push(await browser("one", "First browser"), await browser("two", "Second browser"));
  await waitFor(async () => (await health()).browsers.length === 2);

  const unauthorized = await fetch(`http://127.0.0.1:${apiPort}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(unauthorized.status, 401);

  const result = await rpc("tools/call", { name: "chrome_status", arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status.browsers.map((item) => item.id).sort(), ["one", "two"]);

  const conflict = await rpcRaw("tools/call", { name: "chrome_tabs_list", arguments: {} });
  assert.match(conflict.error.message, /browserId is required/);
  process.stdout.write("integration test passed\n");
} finally {
  for (const socket of sockets) socket.close();
  backend.kill();
}

async function browser(browserId, browserName) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "hello", role: "extension", browserId, browserName, psk }));
  return socket;
}
async function health() { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).json(); }
async function waitForHealth() { await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok; } catch { return false; } }); }
async function waitFor(check) { for (let i = 0; i < 50; i += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Timed out"); }
async function rpc(method, params) { const value = await rpcRaw(method, params); assert.ok(value.result); return value.result; }
async function rpcRaw(method, params) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${psk}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal(response.status, 200);
  return response.json();
}
