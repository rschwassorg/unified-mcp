import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = positiveInteger(process.env.UNIFIED_MCP_FS_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
const MAX_LIST_ENTRIES = 1000;

type FilesystemRootConfig = {
  path: string;
  readOnly?: boolean;
};

type FilesystemConfig = {
  roots?: Record<string, FilesystemRootConfig>;
};

type FilesystemRoot = {
  name: string;
  path: string;
  realPath: string;
  readOnly: boolean;
};

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const pathProperties = {
  root: { type: "string", description: "Configured filesystem root name." },
  path: { type: "string", description: "Path relative to the configured root. Absolute paths and parent traversal are rejected." }
};

export const filesystemTools: ToolDefinition[] = [
  fsTool("fs_roots_list", "List filesystem roots exposed to this Unified MCP server."),
  fsTool("fs_list", "List files and directories within an allowed filesystem root.", {
    ...pathProperties,
    path: { ...pathProperties.path, default: "." },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIST_ENTRIES, default: MAX_LIST_ENTRIES }
  }, ["root"]),
  fsTool("fs_stat", "Get metadata for a file or directory within an allowed filesystem root.", pathProperties, ["root", "path"]),
  fsTool("fs_read_text", "Read a UTF-8 text file within an allowed filesystem root.", {
    ...pathProperties,
    maxBytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES, default: MAX_FILE_BYTES }
  }, ["root", "path"]),
  fsTool("fs_write_text", "Create or replace a UTF-8 text file within a writable filesystem root.", {
    ...pathProperties,
    content: { type: "string" },
    expectedSha256: { type: "string", description: "Optional SHA-256 from a prior read. The write fails if the current file differs." },
    createParents: { type: "boolean", default: false }
  }, ["root", "path", "content"]),
  fsTool("fs_replace_text", "Replace an exact text fragment in a UTF-8 file within a writable filesystem root.", {
    ...pathProperties,
    oldText: { type: "string" },
    newText: { type: "string" },
    expectedOccurrences: { type: "integer", minimum: 1, default: 1 },
    expectedSha256: { type: "string", description: "Optional SHA-256 from a prior read. The edit fails if the current file differs." }
  }, ["root", "path", "oldText", "newText"]),
  fsTool("fs_mkdir", "Create a directory within a writable filesystem root.", {
    ...pathProperties,
    recursive: { type: "boolean", default: true }
  }, ["root", "path"]),
  fsTool("fs_move", "Move or rename a file or directory within one writable filesystem root. The destination must not already exist.", {
    root: pathProperties.root,
    sourcePath: { type: "string", description: "Existing source path relative to the configured root." },
    destinationPath: { type: "string", description: "New destination path relative to the same configured root." },
    createParents: { type: "boolean", default: false }
  }, ["root", "sourcePath", "destinationPath"])
];

const filesystemToolNames = new Set(filesystemTools.map((tool) => tool.name));

export function ownsFilesystemTool(name: string) {
  return filesystemToolNames.has(name);
}

export async function filesystemCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "fs_roots_list":
      return rootsList();
    case "fs_list":
      return listDirectory(args);
    case "fs_stat":
      return statPath(args);
    case "fs_read_text":
      return readText(args);
    case "fs_write_text":
      return writeText(args);
    case "fs_replace_text":
      return replaceText(args);
    case "fs_mkdir":
      return makeDirectory(args);
    case "fs_move":
      return movePath(args);
    default:
      throw new Error(`Unknown filesystem tool: ${name}`);
  }
}

async function rootsList() {
  const roots = await loadRoots();
  return {
    configPath: filesystemConfigPath(),
    roots: Array.from(roots.values(), ({ name, path, readOnly }) => ({ name, path, readOnly }))
  };
}

async function listDirectory(args: Record<string, unknown>) {
  const root = await selectedRoot(args.root);
  const requestedPath = stringArg(args.path, ".");
  const target = await existingPath(root, requestedPath);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${requestedPath}`);
  const limit = boundedInteger(args.limit, MAX_LIST_ENTRIES, 1, MAX_LIST_ENTRIES);
  const values = await readdir(target, { withFileTypes: true });
  values.sort((left, right) => left.name.localeCompare(right.name));
  const entries = values.slice(0, limit).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
  }));
  return {
    root: root.name,
    path: normalizeDisplayPath(requestedPath),
    entries,
    truncated: values.length > entries.length
  };
}

async function statPath(args: Record<string, unknown>) {
  const root = await selectedRoot(args.root);
  const requestedPath = requiredString(args.path, "path");
  const target = await existingPath(root, requestedPath);
  const info = await stat(target);
  return {
    root: root.name,
    path: normalizeDisplayPath(requestedPath),
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    createdAt: info.birthtime.toISOString()
  };
}

async function readText(args: Record<string, unknown>) {
  const root = await selectedRoot(args.root);
  const requestedPath = requiredString(args.path, "path");
  const target = await existingPath(root, requestedPath);
  const maxBytes = boundedInteger(args.maxBytes, MAX_FILE_BYTES, 1, MAX_FILE_BYTES);
  return readTextFile(root, requestedPath, target, maxBytes);
}

async function writeText(args: Record<string, unknown>) {
  const root = await selectedWritableRoot(args.root);
  const requestedPath = requiredString(args.path, "path");
  const content = requiredString(args.content, "content", true);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new Error(`Content exceeds filesystem write limit of ${MAX_FILE_BYTES} bytes`);
  const target = await writablePath(root, requestedPath);
  await verifyExpectedSha(target, optionalString(args.expectedSha256));
  if (booleanArg(args.createParents, false)) {
    await mkdir(dirname(target), { recursive: true });
    await assertExistingWithinRoot(root, dirname(target));
  }
  await atomicWrite(target, content);
  await audit("write", { root: root.name, path: normalizeDisplayPath(requestedPath), bytes });
  return fileWriteResult(root, requestedPath, content);
}

async function replaceText(args: Record<string, unknown>) {
  const root = await selectedWritableRoot(args.root);
  const requestedPath = requiredString(args.path, "path");
  const oldText = requiredString(args.oldText, "oldText", true);
  const newText = requiredString(args.newText, "newText", true);
  if (!oldText.length) throw new Error("oldText must not be empty");
  const expectedOccurrences = boundedInteger(args.expectedOccurrences, 1, 1, 1_000_000);
  const target = await existingPath(root, requestedPath);
  await verifyExpectedSha(target, optionalString(args.expectedSha256));
  const current = await readTextFile(root, requestedPath, target, MAX_FILE_BYTES);
  const occurrences = countOccurrences(current.content, oldText);
  if (occurrences !== expectedOccurrences) {
    throw new Error(`Expected ${expectedOccurrences} occurrence(s) but found ${occurrences}`);
  }
  const content = current.content.split(oldText).join(newText);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error(`Edited content exceeds filesystem write limit of ${MAX_FILE_BYTES} bytes`);
  await atomicWrite(target, content);
  await audit("replace", { root: root.name, path: normalizeDisplayPath(requestedPath), occurrences });
  return fileWriteResult(root, requestedPath, content);
}

async function makeDirectory(args: Record<string, unknown>) {
  const root = await selectedWritableRoot(args.root);
  const requestedPath = requiredString(args.path, "path");
  const target = await writablePath(root, requestedPath);
  await mkdir(target, { recursive: booleanArg(args.recursive, true) });
  await assertExistingWithinRoot(root, target);
  await audit("mkdir", { root: root.name, path: normalizeDisplayPath(requestedPath) });
  return { root: root.name, path: normalizeDisplayPath(requestedPath), created: true };
}

async function movePath(args: Record<string, unknown>) {
  const root = await selectedWritableRoot(args.root);
  const sourcePath = requiredString(args.sourcePath, "sourcePath");
  const destinationPath = requiredString(args.destinationPath, "destinationPath");
  const source = await existingPath(root, sourcePath);
  const destination = await writablePath(root, destinationPath);
  if (await pathExists(destination)) throw new Error(`Destination already exists: ${destinationPath}`);
  if (booleanArg(args.createParents, false)) {
    await mkdir(dirname(destination), { recursive: true });
    await assertExistingWithinRoot(root, dirname(destination));
  }
  await rename(source, destination);
  await assertExistingWithinRoot(root, destination);
  await audit("move", {
    root: root.name,
    sourcePath: normalizeDisplayPath(sourcePath),
    destinationPath: normalizeDisplayPath(destinationPath)
  });
  return {
    root: root.name,
    sourcePath: normalizeDisplayPath(sourcePath),
    destinationPath: normalizeDisplayPath(destinationPath),
    moved: true
  };
}

async function readTextFile(root: FilesystemRoot, requestedPath: string, target: string, maxBytes: number) {
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Not a file: ${requestedPath}`);
  if (info.size > maxBytes) throw new Error(`File is ${info.size} bytes, above the read limit of ${maxBytes} bytes`);
  const content = await readFile(target, "utf8");
  return {
    root: root.name,
    path: normalizeDisplayPath(requestedPath),
    size: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
    content
  };
}

async function fileWriteResult(root: FilesystemRoot, requestedPath: string, content: string) {
  const target = await existingPath(root, requestedPath);
  const info = await stat(target);
  return {
    root: root.name,
    path: normalizeDisplayPath(requestedPath),
    size: info.size,
    sha256: sha256(content),
    modifiedAt: info.mtime.toISOString()
  };
}

async function selectedRoot(value: unknown) {
  const name = requiredString(value, "root");
  const roots = await loadRoots();
  const root = roots.get(name);
  if (!root) throw new Error(`Unknown filesystem root: ${name}`);
  return root;
}

async function selectedWritableRoot(value: unknown) {
  const root = await selectedRoot(value);
  if (root.readOnly) throw new Error(`Filesystem root is read-only: ${root.name}`);
  return root;
}

async function loadRoots(): Promise<Map<string, FilesystemRoot>> {
  const configPath = filesystemConfigPath();
  if (!configPath) throw new Error("UNIFIED_MCP_FS_CONFIG is not configured and ProgramData is unavailable");
  let parsed: FilesystemConfig;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as FilesystemConfig;
  } catch (error) {
    throw new Error(`Unable to read filesystem configuration at ${configPath}: ${errorMessage(error)}`);
  }
  const values = parsed.roots;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Filesystem configuration must contain a roots object");
  const roots = new Map<string, FilesystemRoot>();
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`Invalid filesystem root name: ${name}`);
    if (!value || typeof value !== "object" || typeof value.path !== "string") throw new Error(`Invalid filesystem root configuration: ${name}`);
    if (!isAbsolute(value.path) && !win32.isAbsolute(value.path)) throw new Error(`Filesystem root must be absolute: ${name}`);
    const configuredPath = resolve(value.path);
    let canonical: string;
    try {
      canonical = await realpath(configuredPath);
    } catch (error) {
      throw new Error(`Filesystem root does not exist or cannot be resolved: ${name}: ${errorMessage(error)}`);
    }
    roots.set(name, { name, path: configuredPath, realPath: canonical, readOnly: value.readOnly === true });
  }
  return roots;
}

function filesystemConfigPath() {
  if (process.env.UNIFIED_MCP_FS_CONFIG) return process.env.UNIFIED_MCP_FS_CONFIG;
  return process.env.ProgramData ? resolve(process.env.ProgramData, "UnifiedMcp", "filesystem-roots.json") : "";
}

async function existingPath(root: FilesystemRoot, input: string) {
  const target = lexicalPath(root, input);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (error) {
    throw new Error(`Path does not exist: ${normalizeDisplayPath(input)}: ${errorMessage(error)}`);
  }
  assertWithin(root.realPath, canonical);
  return target;
}

async function writablePath(root: FilesystemRoot, input: string) {
  const target = lexicalPath(root, input);
  if (await pathExists(target)) {
    const canonical = await realpath(target);
    assertWithin(root.realPath, canonical);
    return target;
  }
  const ancestor = await nearestExistingAncestor(dirname(target));
  const canonicalAncestor = await realpath(ancestor);
  assertWithin(root.realPath, canonicalAncestor);
  return target;
}

function lexicalPath(root: FilesystemRoot, input: string) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path must be a non-empty string");
  if (input.includes("\0")) throw new Error("NUL bytes are not allowed in filesystem paths");
  const normalized = input.replace(/\\/g, "/");
  if (isAbsolute(input) || win32.isAbsolute(input) || normalized.startsWith("//")) throw new Error("Absolute and UNC filesystem paths are not allowed");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Parent path traversal is not allowed");
  const target = resolve(root.path, normalized);
  assertWithin(root.path, target);
  return target;
}

async function assertExistingWithinRoot(root: FilesystemRoot, target: string) {
  const canonical = await realpath(target);
  assertWithin(root.realPath, canonical);
}

function assertWithin(root: string, candidate: string) {
  const rel = relative(root, candidate);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Resolved filesystem path escapes the configured root");
}

async function nearestExistingAncestor(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to find an existing parent directory");
    current = parent;
  }
}

async function verifyExpectedSha(target: string, expectedSha256?: string) {
  if (!expectedSha256) return;
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256");
  if (!(await pathExists(target))) throw new Error("SHA-256 conflict: target file does not exist");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("SHA-256 conflict: target is not a file");
  if (info.size > MAX_FILE_BYTES) throw new Error(`Existing file exceeds SHA verification limit of ${MAX_FILE_BYTES} bytes`);
  const actual = sha256(await readFile(target));
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`SHA-256 conflict: expected ${expectedSha256}, found ${actual}`);
}

async function atomicWrite(target: string, content: string) {
  const parent = dirname(target);
  const temp = resolve(parent, `.${basename(target)}.unified-mcp-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, target);
  } catch (error) {
    if (process.platform !== "win32") {
      await rm(temp, { force: true });
      throw error;
    }
    try {
      await rm(target, { force: true });
      await rename(temp, target);
    } catch {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function audit(operation: string, details: Record<string, unknown>) {
  const auditPath = process.env.UNIFIED_MCP_FS_AUDIT_LOG
    || (process.env.ProgramData ? resolve(process.env.ProgramData, "UnifiedMcp", "logs", "filesystem-audit.log") : "");
  if (!auditPath) return;
  try {
    await appendFile(auditPath, `${new Date().toISOString()} ${operation} ${JSON.stringify(details)}\n`, "utf8");
  } catch {
    // Audit logging must not make filesystem operations fail.
  }
}

function fsTool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  return {
    name,
    title: name,
    description,
    inputSchema: { type: "object", title: `${name}_input`, additionalProperties: false, properties, required }
  };
}

function normalizeDisplayPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return normalized === "" ? "." : normalized;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function countOccurrences(value: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function requiredString(value: unknown, name: string, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.length)) throw new Error(`${name} must be a string${allowEmpty ? "" : " and must not be empty"}`);
  return value;
}

function optionalString(value: unknown) {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function stringArg(value: unknown, fallback: string) {
  return value === undefined || value === null ? fallback : requiredString(value, "path");
}

function booleanArg(value: unknown, fallback: boolean) {
  return value === undefined ? fallback : value === true || value === "true";
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  return number;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isNotFound(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
