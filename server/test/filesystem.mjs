import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const temp = await mkdtemp(join(tmpdir(), "unified-mcp-fs-"));
const writable = join(temp, "writable");
const readonly = join(temp, "readonly");
const outside = join(temp, "outside");
const configPath = join(temp, "filesystem-roots.json");
const apiPort = 29766;

await mkdir(writable);
await mkdir(readonly);
await mkdir(outside);
await writeFile(join(readonly, "existing.txt"), "read only\n", "utf8");
await writeFile(join(outside, "secret.txt"), "outside\n", "utf8");
await writeFile(configPath, "\uFEFF" + JSON.stringify({
  roots: {
    work: { path: writable, readOnly: false },
    docs: { path: readonly, readOnly: true }
  }
}), "utf8");

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    UNIFIED_MCP_PORT: String(apiPort),
    UNIFIED_MCP_ALLOW_NO_AUTH: "true",
    UNIFIED_MCP_KEEP_ALIVE: "1",
    UNIFIED_MCP_FS_CONFIG: configPath,
    VIBETERM_MCP_DISABLED: "true"
  },
  stdio: "ignore"
});

try {
  await waitForHealth();

  const tools = await rpc("tools/list", {});
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["fs_roots_list", "fs_list", "fs_stat", "fs_read_text", "fs_write_text", "fs_replace_text", "fs_mkdir", "fs_move"]) {
    assert.ok(names.has(name), `missing filesystem tool: ${name}`);
  }
  const fsReadTool = tools.tools.find((tool) => tool.name === "fs_read_text");
  assert.equal("browserId" in fsReadTool.inputSchema.properties, false);

  const roots = textResult(await call("fs_roots_list", {}));
  assert.deepEqual(roots.roots.map((root) => root.name).sort(), ["docs", "work"]);

  const made = textResult(await call("fs_mkdir", { root: "work", path: "project/src" }));
  assert.equal(made.created, true);

  const write = textResult(await call("fs_write_text", {
    root: "work",
    path: "project/src/example.txt",
    content: "hello world\n"
  }));
  assert.match(write.sha256, /^[a-f0-9]{64}$/);

  const read = textResult(await call("fs_read_text", { root: "work", path: "project/src/example.txt" }));
  assert.equal(read.content, "hello world\n");
  assert.equal(read.sha256, write.sha256);

  const conflict = await callRaw("fs_write_text", {
    root: "work",
    path: "project/src/example.txt",
    content: "should fail\n",
    expectedSha256: "0".repeat(64)
  });
  assert.match(conflict.error.message, /SHA-256 conflict/);

  const replaced = textResult(await call("fs_replace_text", {
    root: "work",
    path: "project/src/example.txt",
    oldText: "world",
    newText: "filesystem",
    expectedOccurrences: 1,
    expectedSha256: read.sha256
  }));
  assert.match(replaced.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(writable, "project", "src", "example.txt"), "utf8"), "hello filesystem\n");

  const moved = textResult(await call("fs_move", {
    root: "work",
    sourcePath: "project/src/example.txt",
    destinationPath: "project/example.txt"
  }));
  assert.equal(moved.moved, true);

  const listing = textResult(await call("fs_list", { root: "work", path: "project" }));
  assert.ok(listing.entries.some((entry) => entry.name === "example.txt"));

  const traversal = await callRaw("fs_read_text", { root: "work", path: "../outside/secret.txt" });
  assert.match(traversal.error.message, /Parent path traversal/);

  const absolute = await callRaw("fs_read_text", { root: "work", path: join(outside, "secret.txt") });
  assert.match(absolute.error.message, /Absolute and UNC/);

  const readonlyWrite = await callRaw("fs_write_text", { root: "docs", path: "blocked.txt", content: "nope" });
  assert.match(readonlyWrite.error.message, /read-only/);

  try {
    await symlink(outside, join(writable, "escape"), "dir");
    const escape = await callRaw("fs_read_text", { root: "work", path: "escape/secret.txt" });
    assert.match(escape.error.message, /escapes the configured root/);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }

  process.stdout.write("filesystem test passed\n");
} finally {
  backend.kill();
  await rm(temp, { recursive: true, force: true });
}

async function waitForHealth() {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok;
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
  throw new Error("Timed out");
}

async function rpc(method, params) {
  const value = await rpcRawRequest(method, params);
  assert.ok(value.result, value.error?.message);
  return value.result;
}

async function call(name, args) {
  const value = await callRaw(name, args);
  assert.ok(value.result, value.error?.message);
  return value.result;
}

async function callRaw(name, args) {
  return rpcRawRequest("tools/call", { name, arguments: args });
}

async function rpcRawRequest(method, params) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  assert.equal(response.status, 200);
  return response.json();
}

function textResult(result) {
  assert.ok(Array.isArray(result.content));
  return JSON.parse(result.content[0].text);
}
