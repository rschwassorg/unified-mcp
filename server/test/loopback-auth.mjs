import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { spawn } from "node:child_process";

const apiPort = 28770;
const bridgePort = 28769;
const psk = randomBytes(32).toString("base64url");
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    CHROME_API_PORT: String(apiPort),
    CHROME_MCP_PORT: String(bridgePort),
    UNIFIED_MCP_PSK: psk,
    UNIFIED_MCP_ALLOW_NO_AUTH: "false",
    UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH: "true",
    UNIFIED_MCP_KEEP_ALIVE: "1"
  },
  stdio: "ignore"
});

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok; }
    catch { return false; }
  });

  const localResponse = await rpcWithHost(`127.0.0.1:${apiPort}`);
  assert.equal(localResponse.status, 200);

  const forwardedResponse = await rpcWithHost("unified-mcp.pentestsystem.com");
  assert.equal(forwardedResponse.status, 401);
  process.stdout.write("loopback authentication test passed\n");
} finally {
  backend.kill();
}

function rpcWithHost(host) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const outbound = request({
      hostname: "127.0.0.1",
      port: apiPort,
      path: "/mcp",
      method: "POST",
      headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    outbound.once("error", reject);
    outbound.end(body);
  });
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out");
}
