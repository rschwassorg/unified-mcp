import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const port = 28784;
const certsPort = 28785;
const teamDomain = "https://test.cloudflareaccess.com";
const audience = "test-audience";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key";
jwk.alg = "RS256";
jwk.use = "sig";

const certs = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => certs.listen(certsPort, "127.0.0.1", resolve));

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "test",
    UNIFIED_MCP_PORT: String(port),
    UNIFIED_MCP_ALLOW_NO_AUTH: "false",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN: teamDomain,
    UNIFIED_MCP_CF_ACCESS_AUD: audience,
    UNIFIED_MCP_CF_ACCESS_CERTS_URL: `http://127.0.0.1:${certsPort}/cdn-cgi/access/certs`,
    VIBETERM_MCP_DISABLED: "true",
  },
  stdio: "ignore",
});

let socket;
try {
  await waitForBackend();

  const noJwt = await mcp({});
  assert.equal(noJwt.status, 401);

  const goodJwt = jwt({
    iss: teamDomain,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 300,
    nbf: Math.floor(Date.now() / 1000) - 5,
    sub: "user-123",
    email: "user@example.com",
  });

  const good = await mcp({ "cf-access-jwt-assertion": goodJwt });
  assert.equal(good.status, 200);
  const goodJson = await good.json();
  assert.deepEqual(goodJson.result, {});

  const wrongAud = jwt({
    iss: teamDomain,
    aud: ["wrong-audience"],
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const denied = await mcp({ "cf-access-jwt-assertion": wrongAud });
  assert.equal(denied.status, 403);

  const expired = jwt({
    iss: teamDomain,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  const stale = await mcp({ "cf-access-jwt-assertion": expired });
  assert.equal(stale.status, 401);

  const unauthorizedUpgradeStatus = await websocketStatus();
  assert.equal(unauthorizedUpgradeStatus, 401);

  socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { "cf-access-jwt-assertion": goodJwt },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "hello",
    role: "extension",
    browserId: "access-browser",
    browserName: "Access Browser",
  }));

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "cf-access-jwt-assertion": goodJwt },
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.browsers.some((browser) => browser.id === "access-browser");
  });

  process.stdout.write("cloudflare access integration test passed\n");
} finally {
  socket?.close();
  backend.kill();
  await new Promise((resolve) => certs.close(resolve));
}

function mcp(headers) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
  });
}

function websocketStatus() {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    websocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    websocket.once("open", () => {
      websocket.close();
      reject(new Error("Unauthorized WebSocket unexpectedly connected"));
    });
    websocket.once("error", () => {});
  });
}

function jwt(payload) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = signData("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function waitForBackend() {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      return response.status === 401;
    } catch {
      return false;
    }
  });
}

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for backend");
}
