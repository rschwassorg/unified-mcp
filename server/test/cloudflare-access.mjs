import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const apiPort = 28784;
const bridgePort = 28783;
const certsPort = 28785;
const psk = "chrome-bridge-psk-test";
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
    CHROME_API_PORT: String(apiPort),
    CHROME_MCP_PORT: String(bridgePort),
    UNIFIED_MCP_PSK: psk,
    UNIFIED_MCP_ALLOW_NO_AUTH: "false",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN: teamDomain,
    UNIFIED_MCP_CF_ACCESS_AUD: audience,
    UNIFIED_MCP_CF_ACCESS_CERTS_URL: `http://127.0.0.1:${certsPort}/cdn-cgi/access/certs`,
    VIBETERM_MCP_DISABLED: "true",
  },
  stdio: "ignore",
});

try {
  await waitForHealth();

  const noJwt = await mcp({ authorization: `Bearer ${psk}` });
  assert.equal(noJwt.status, 401, "Chrome PSK must not authenticate HTTP MCP when Access is enabled");

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

  process.stdout.write("cloudflare access integration test passed\n");
} finally {
  backend.kill();
  await new Promise((resolve) => certs.close(resolve));
}

function mcp(headers) {
  return fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
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

async function waitForHealth() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for backend");
}
