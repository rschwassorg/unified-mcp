import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const apiPort = 28772;
const upstreamPort = 28773;
const token = "test-shared-token";

const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = rpc.method === "tools/list"
    ? { tools: [{ name: "terminal_echo", description: "Echo through VibeTerm.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
    : { content: [{ type: "text", text: JSON.stringify(rpc.params.arguments) }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`);
});
await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    UNIFIED_MCP_PORT: String(apiPort),
    UNIFIED_MCP_ALLOW_NO_AUTH: "true",
    VIBETERM_API_TOKEN: token,
    UNIFIED_MCP_KEEP_ALIVE: "1",
    VIBETERM_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp`
  },
  stdio: "ignore"
});

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok; }
    catch { return false; }
  });

  const listed = await rpc("tools/list", {});
  assert.ok(listed.tools.some((tool) => tool.name === "chrome_status"));
  assert.ok(listed.tools.some((tool) => tool.name === "terminal_echo"));

  const called = await rpc("tools/call", { name: "terminal_echo", arguments: { text: "hello" } });
  assert.deepEqual(JSON.parse(called.content[0].text), { text: "hello" });

  const health = await (await fetch(`http://127.0.0.1:${apiPort}/health`)).json();
  assert.equal(health.upstreams[0].connected, true);
  assert.equal(health.upstreams[0].toolCount, 1);

  process.stdout.write("VibeTerm upstream integration test passed\n");
} finally {
  backend.kill();
  upstream.close();
}

async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(value.result, value.error?.message);
  return value.result;
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out");
}
