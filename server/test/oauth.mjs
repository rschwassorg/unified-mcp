import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const apiPort = 28774;
const bridgePort = 28773;
const psk = randomBytes(32).toString("base64url");
const issuer = `http://127.0.0.1:${apiPort}`;
const resource = `${issuer}/mcp`;
const redirectUri = "http://127.0.0.1:34567/callback";
const work = await mkdtemp(join(tmpdir(), "unified-mcp-oauth-"));

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    CHROME_API_PORT: String(apiPort),
    CHROME_MCP_PORT: String(bridgePort),
    UNIFIED_MCP_PSK: psk,
    UNIFIED_MCP_ALLOW_NO_AUTH: "false",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    UNIFIED_MCP_OAUTH_ISSUER: issuer,
    UNIFIED_MCP_OAUTH_STATE_FILE: join(work, "oauth-state.json"),
    UNIFIED_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS: "mcp.pentestsystem.com,oauth-callbacks.cloudflareaccess.com",
    VIBETERM_MCP_DISABLED: "true",
  },
  stdio: "ignore",
});

try {
  await waitForHealth();

  const pskRejected = await mcp("ping", {}, psk);
  assert.equal(pskRejected.status, 401);
  assert.match(pskRejected.headers.get("www-authenticate") || "", /resource_metadata=/);

  const protectedMetadata = await fetch(`${issuer}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedMetadata.status, 200);
  const protectedJson = await protectedMetadata.json();
  assert.equal(protectedJson.resource, resource);
  assert.deepEqual(protectedJson.authorization_servers, [issuer]);

  const authorizationMetadata = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationMetadata.status, 200);
  const authorizationJson = await authorizationMetadata.json();
  assert.equal(authorizationJson.issuer, issuer);
  assert.equal(authorizationJson.registration_endpoint, `${issuer}/register`);
  assert.deepEqual(authorizationJson.code_challenge_methods_supported, ["S256"]);

  const registration = await fetch(`${issuer}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Cloudflare MCP Portal test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp offline_access",
      application_type: "web",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  assert.ok(client.client_id);
  assert.equal(client.token_endpoint_auth_method, "none");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(`${issuer}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "mcp offline_access");
  authUrl.searchParams.set("state", "cloudflare-state");
  authUrl.searchParams.set("resource", resource);

  const authorization = await fetch(authUrl, { redirect: "manual" });
  assert.equal(authorization.status, 200);
  const html = await authorization.text();
  const transaction = html.match(/name="transaction" value="([^"]+)"/)?.[1];
  assert.ok(transaction);

  const approval = await fetch(`${issuer}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, action: "approve" }),
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), "cloudflare-state");
  assert.equal(callback.searchParams.get("iss"), issuer);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.token_type, "Bearer");

  const authorized = await mcp("ping", {}, tokens.access_token);
  assert.equal(authorized.status, 200);
  const authorizedJson = await authorized.json();
  assert.deepEqual(authorizedJson.result, {});

  const refreshResponse = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  const revokeResponse = await fetch(`${issuer}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshed.access_token }),
  });
  assert.equal(revokeResponse.status, 200);

  const revoked = await mcp("ping", {}, refreshed.access_token);
  assert.equal(revoked.status, 401);

  process.stdout.write("oauth test passed\n");
} finally {
  backend.kill();
  await rm(work, { recursive: true, force: true });
}

function mcp(method, params, token) {
  return fetch(`${issuer}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function waitForHealth() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${issuer}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for OAuth test backend");
}
