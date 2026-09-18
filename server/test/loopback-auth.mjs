import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";

const port = 28770;
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    UNIFIED_MCP_PORT: String(port),
    UNIFIED_MCP_ALLOW_NO_AUTH: "false",
    UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH: "true",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    VIBETERM_MCP_DISABLED: "true"
  },
  stdio: "ignore"
});

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; }
    catch { return false; }
  });

  const localResponse = await rpcWithHost(`127.0.0.1:${port}`);
  assert.equal(localResponse.status, 200);

  const forwardedResponse = await rpcWithHost("unified-mcp.pentestsystem.com");
  assert.equal(forwardedResponse.status, 503);

  process.stdout.write("loopback authentication test passed\n");
} finally {
  backend.kill();
}

function rpcWithHost(host) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const outbound = request({
      hostname: "127.0.0.1",
      port,
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
