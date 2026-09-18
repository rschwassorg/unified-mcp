import { appendFileSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { HttpMcpUpstream } from "./mcp-upstream.js";
import { filesystemCall, filesystemTools, ownsFilesystemTool } from "./filesystem.js";
import { UnifiedMcpOAuthServer } from "./oauth.js";

const require = createRequire(import.meta.url);
const BRIDGE_PORT = Number(process.env.CHROME_MCP_PORT ?? 18765);
const API_PORT = Number(process.env.CHROME_API_PORT ?? 18766);
const BIND_HOST = process.env.CHROME_BIND_HOST ?? "127.0.0.1";
const AGENT_API_HOST = process.env.CHROME_AGENT_API_HOST || "";
const AGENT_API_PORT = Number(process.env.CHROME_AGENT_API_PORT ?? 0);
const REQUEST_TIMEOUT_MS = Number(process.env.CHROME_MCP_TIMEOUT_MS ?? 15000);
const DEBUG_LOG = process.env.CHROME_MCP_DEBUG_LOG || join(process.cwd(), "chrome-mcp-debug.log");
const PUBLIC_DIR = join(process.cwd(), "public");
const VIBETERM_MCP_URL = process.env.VIBETERM_MCP_URL ?? "http://127.0.0.1:47821/mcp";
const OAUTH_ISSUER = (process.env.UNIFIED_MCP_OAUTH_ISSUER || "").replace(/\/+$/, "");
const OAUTH_STATE_FILE = process.env.UNIFIED_MCP_OAUTH_STATE_FILE || join(process.cwd(), "oauth-state.json");
const OAUTH_ALLOWED_REDIRECT_HOSTS = (process.env.UNIFIED_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const OAUTH_CF_ACCESS_TEAM_DOMAIN = process.env.UNIFIED_MCP_OAUTH_CF_ACCESS_TEAM_DOMAIN || "";
const OAUTH_CF_ACCESS_AUD = process.env.UNIFIED_MCP_OAUTH_CF_ACCESS_AUD || "";

type ChromeRequest = { type: "request"; id: string; method: string; params?: Record<string, unknown> };
type ChromeResponse = { type: "response"; id: string; ok: boolean; result?: unknown; error?: string };
type BridgeMessage = ChromeResponse | { type: "heartbeat"; time?: number } | { type: "hello"; role: "extension"; browserId?: string; browserName?: string; psk?: string };
type ProtocolDomain = { domain: string; description?: string; experimental?: boolean; deprecated?: boolean; dependencies?: string[]; types?: unknown[]; commands?: unknown[]; events?: unknown[] };
type ProtocolDefinition = { version: { major: string; minor: string }; domains: ProtocolDomain[] };
type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };

const browserProtocol = require("devtools-protocol/json/browser_protocol.json") as ProtocolDefinition;
const jsProtocol = require("devtools-protocol/json/js_protocol.json") as ProtocolDefinition;
const cdpProtocol: ProtocolDefinition = { version: browserProtocol.version, domains: [...browserProtocol.domains, ...jsProtocol.domains] };

const PSK = process.env.UNIFIED_MCP_PSK || (process.env.UNIFIED_MCP_PSK_FILE ? readFileSync(process.env.UNIFIED_MCP_PSK_FILE, "utf8").trim() : "");
const ALLOW_NO_AUTH = process.env.UNIFIED_MCP_ALLOW_NO_AUTH === "true";
const ALLOW_LOOPBACK_NO_AUTH = process.env.UNIFIED_MCP_ALLOW_LOOPBACK_NO_AUTH === "true";
const oauthServer = OAUTH_ISSUER ? new UnifiedMcpOAuthServer({
  issuer: OAUTH_ISSUER,
  resource: `${OAUTH_ISSUER}/mcp`,
  stateFile: OAUTH_STATE_FILE,
  allowedRedirectHosts: OAUTH_ALLOWED_REDIRECT_HOSTS,
  cloudflareAccessTeamDomain: OAUTH_CF_ACCESS_TEAM_DOMAIN,
  cloudflareAccessAudience: OAUTH_CF_ACCESS_AUD,
}) : undefined;
type BrowserConnection = { id: string; name: string; socket: WebSocket; connectedAt: string; lastSeenAt: string };
const pending = new Map<string, { browserId: string; resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout }>();
const browsers = new Map<string, BrowserConnection>();
const socketBrowserIds = new WeakMap<WebSocket, string>();
let shuttingDown = false;
const vibeTermMcp = process.env.VIBETERM_MCP_DISABLED === "true" ? undefined : new HttpMcpUpstream(
  "vibeterm",
  VIBETERM_MCP_URL,
  process.env.VIBETERM_API_TOKEN || PSK,
  Number(process.env.VIBETERM_MCP_TIMEOUT_MS ?? 5000)
);

const wss = new WebSocketServer({ host: BIND_HOST, port: BRIDGE_PORT });
wss.on("error", (error) => {
  debug("websocket-error", { message: error.message });
  console.error(`Chrome bridge WebSocket failed: ${error.message}`);
  process.exitCode = 1;
});
wss.on("connection", (socket) => {
  const authenticationTimeout = setTimeout(() => {
    if (!socketBrowserIds.has(socket)) socket.close(1008, "Authentication timeout");
  }, 5000);
  socket.on("message", (data) => {
    let message: BridgeMessage;
    try { message = JSON.parse(data.toString()) as BridgeMessage; } catch { return; }
    if (message.type === "hello") {
      if (!message.browserId || (!ALLOW_NO_AUTH && (!PSK || !safeEqual(message.psk || "", PSK)))) {
        socket.close(1008, "Authentication failed");
        return;
      }
      registerBrowser(socket, message.browserId, message.browserName || message.browserId);
      clearTimeout(authenticationTimeout);
      return;
    }
    if (message.type === "heartbeat") {
      const browserId = socketBrowserIds.get(socket);
      const browser = browserId ? browsers.get(browserId) : undefined;
      if (browser) browser.lastSeenAt = new Date().toISOString();
      return;
    }
    if (message.type !== "response" || !message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(message.id);
    message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error || "Chrome extension request failed"));
  });
  socket.on("close", () => {
    clearTimeout(authenticationTimeout);
    const browserId = socketBrowserIds.get(socket);
    if (!browserId || browsers.get(browserId)?.socket !== socket) return;
    browsers.delete(browserId);
    for (const [id, waiter] of pending) {
      if (waiter.browserId !== browserId) continue;
      clearTimeout(waiter.timeout);
      pending.delete(id);
      waiter.reject(new Error(`Browser ${browserId} disconnected before responding.`));
    }
  });
});

const apiHandler = (request: IncomingMessage, response: ServerResponse) => { void handleHttp(request, response); };
const api = createServer(apiHandler);
api.listen(API_PORT, BIND_HOST, () => debug("api-start", { apiPort: API_PORT, bridgePort: BRIDGE_PORT, bindHost: BIND_HOST, pid: process.pid }));
api.on("error", (error) => {
  debug("api-error", { message: error.message });
  console.error(`Chrome API failed: ${error.message}`);
  process.exitCode = 1;
});
if (AGENT_API_HOST || AGENT_API_PORT) {
  if (!AGENT_API_HOST || !Number.isInteger(AGENT_API_PORT) || AGENT_API_PORT < 1 || AGENT_API_PORT > 65535) {
    throw new Error("CHROME_AGENT_API_HOST and a valid CHROME_AGENT_API_PORT must be configured together");
  }
  const agentApi = createServer(apiHandler);
  agentApi.listen(AGENT_API_PORT, AGENT_API_HOST, () => debug("agent-api-start", { agentApiPort: AGENT_API_PORT, agentApiHost: AGENT_API_HOST, pid: process.pid }));
  agentApi.on("error", (error) => {
    debug("agent-api-error", { message: error.message });
    console.error(`Chrome agent API failed: ${error.message}`);
    process.exitCode = 1;
  });
}

// MCP remains available over stdio for existing clients. HTTP is an additional interface.
const chromeMcpTools = [
  mcpTool("chrome_browsers_list", "List connected Chrome browser clients."),
  mcpTool("chrome_status", "Check whether the Chrome extension is connected."),
  mcpTool("chrome_tabs_list", "List open Chrome tabs."),
  mcpTool("chrome_tab_open", "Open Chrome tab.", { url: { type: "string" }, active: { type: "boolean", default: true } }, ["url"]),
  mcpTool("chrome_tab_activate", "Activate and focus a Chrome tab.", { tabId: { type: "integer" } }, ["tabId"]),
  mcpTool("chrome_tab_close", "Close a Chrome tab.", { tabId: { type: "integer" } }, ["tabId"]),
  mcpTool("chrome_page_info", "Get page metadata.", { tabId: { type: "integer" } }),
  mcpTool("chrome_page_text", "Get visible page text.", { tabId: { type: "integer" } }),
  mcpTool("chrome_page_click", "Click an element by CSS selector.", { selector: { type: "string" }, tabId: { type: "integer" } }, ["selector"]),
  mcpTool("chrome_page_type", "Type text into an input or textarea.", { selector: { type: "string" }, text: { type: "string" }, clear: { type: "boolean", default: true }, tabId: { type: "integer" } }, ["selector", "text"]),
  mcpTool("chrome_page_script", "Run a JavaScript expression.", { script: { type: "string" }, tabId: { type: "integer" } }, ["script"]),
  mcpTool("chrome_cdp_targets", "List CDP targets."),
  mcpTool("chrome_cdp_protocol", "Read bundled Chrome DevTools Protocol metadata.", { domain: { type: "string" }, includeExperimental: { type: "boolean", default: true }, includeDeprecated: { type: "boolean", default: true }, includeDetails: { type: "boolean", default: false } }),
  mcpTool("chrome_cdp_attached", "List attached CDP targets."),
  mcpTool("chrome_cdp_attach", "Attach CDP.", { tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" }, protocolVersion: { type: "string", default: "1.3" } }),
  mcpTool("chrome_cdp_detach", "Detach CDP.", { tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" } }),
  mcpTool("chrome_cdp_send", "Send any Chrome DevTools Protocol command.", { command: { type: "string" }, params: { type: "object", default: {} }, tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" }, protocolVersion: { type: "string", default: "1.3" }, autoAttach: { type: "boolean", default: true }, detach: { type: "boolean", default: false } }, ["command"]),
  mcpTool("chrome_cdp_call", "Send a CDP command with auto-attach.", { command: { type: "string" }, params: { type: "object", default: {} }, tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" }, protocolVersion: { type: "string", default: "1.3" }, detach: { type: "boolean", default: false } }, ["command"]),
  mcpTool("chrome_cdp_events", "Poll buffered CDP events.", { limit: { type: "integer", default: 100 }, clear: { type: "boolean", default: false }, method: { type: "string" }, tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" } })
];
const localMcpTools = [...chromeMcpTools, ...filesystemTools];
const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
readline.on("line", (line) => { void handleMcpLine(line); });
readline.on("close", () => { if (process.env.UNIFIED_MCP_KEEP_ALIVE !== "1") shutdown(); });

async function handleMcpLine(line: string) {
  if (!line.trim()) return;
  let request: JsonRpcRequest;
  try { request = JSON.parse(line) as JsonRpcRequest; } catch { return; }
  if (request.method.startsWith("notifications/") || request.id === undefined) return;
  try { respondMcp(request.id, await handleMcpRequest(request)); } catch (error) { respondMcpError(request.id, errorMessage(error)); }
}

async function handleMcpRequest(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize": return { protocolVersion: String(request.params?.protocolVersion || "2024-11-05"), capabilities: { tools: { listChanged: true } }, serverInfo: { name: "unified_mcp", version: "0.3.0" } };
    case "tools/list": return { tools: await unifiedMcpTools() };
    case "tools/call": return mcpCall(String(request.params?.name || ""), asObject(request.params?.arguments));
    case "ping": return {};
    default: throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const method: Record<string, string> = {
    chrome_tabs_list: "tabs.list", chrome_tab_open: "tabs.open", chrome_tab_activate: "tabs.activate", chrome_tab_close: "tabs.close",
    chrome_page_info: "page.info", chrome_page_text: "page.text", chrome_page_click: "page.click", chrome_page_type: "page.type", chrome_page_script: "page.script",
    chrome_cdp_targets: "cdp.targets", chrome_cdp_attached: "cdp.attached", chrome_cdp_attach: "cdp.attach", chrome_cdp_detach: "cdp.detach", chrome_cdp_send: "cdp.send", chrome_cdp_call: "cdp.send", chrome_cdp_events: "cdp.events"
  };
  if (name === "chrome_status" || name === "chrome_browsers_list") return mcpText(serverStatus());
  if (name === "chrome_cdp_protocol") return mcpText(getCdpProtocol(args));
  if (ownsFilesystemTool(name)) return mcpText(await filesystemCall(name, args));
  if (vibeTermMcp?.ownsTool(name)) return vibeTermMcp.callTool(name, args);
  if (!method[name]) throw new Error(`Unknown tool: ${name}`);
  const defaults = name === "chrome_page_type" ? { clear: true } : name === "chrome_cdp_attach" ? { protocolVersion: "1.3" } : name === "chrome_cdp_send" || name === "chrome_cdp_call" ? { params: {}, autoAttach: true, protocolVersion: "1.3" } : {};
  return mcpText(await chrome(method[name], { ...defaults, ...args }));
}

async function unifiedMcpTools() {
  const upstreamTools = vibeTermMcp ? await vibeTermMcp.listTools() : [];
  const localNames = new Set(localMcpTools.map((tool) => tool.name));
  return [...localMcpTools, ...upstreamTools.filter((tool) => !localNames.has(tool.name))];
}

async function handleHttp(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (oauthServer && await oauthServer.handlePublicEndpoint(request, response, url)) return;
    if (request.method === "GET" && ["/", "/app.js", "/styles.css"].includes(url.pathname)) return sendDashboardAsset(response, url.pathname);
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, serverStatus());
    if (request.method === "GET" && url.pathname === "/openapi.json") { authorize(request); return sendJson(response, 200, openApi()); }
    if (url.pathname === "/mcp") {
      authorize(request);
      if (request.method !== "POST") throw new HttpError(405, "MCP uses POST");
      const rpc = await readJson(request) as JsonRpcRequest;
      if (!rpc.jsonrpc || !rpc.method) throw new HttpError(400, "Invalid JSON-RPC request");
      if (rpc.id === undefined) return response.writeHead(202).end();
      try { return sendJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result: await handleMcpRequest(rpc) }); }
      catch (error) { return sendJson(response, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: errorMessage(error) } }); }
    }
    authorize(request);

    const body = request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
    body.browserId ??= request.headers["x-browser-id"] || url.searchParams.get("browserId") || undefined;
    const result = await route(request.method || "GET", url, body);
    return sendJson(response, 200, result);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const headers = error instanceof HttpError ? error.headers : {};
    sendJson(response, status, { error: errorMessage(error) }, headers);
  }
}

async function route(method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
  const path = url.pathname;
  const tabId = path.match(/^\/v1\/tabs\/(\d+)$/)?.[1];
  const pageMatch = path.match(/^\/v1\/pages\/(\d+)\/(info|text|click|type|script)$/);
  if (method === "GET" && path === "/v1/tabs") return chrome("tabs.list");
  if (method === "POST" && path === "/v1/tabs") return chrome("tabs.open", body);
  if (method === "POST" && /^\/v1\/tabs\/\d+\/activate$/.test(path)) return chrome("tabs.activate", { tabId: numericPathId(path) });
  if (method === "DELETE" && tabId) return chrome("tabs.close", { tabId: Number(tabId) });
  if (pageMatch) {
    const [, id, action] = pageMatch;
    const params = { ...body, tabId: Number(id) };
    if (method === "GET" && action === "info") return chrome("page.info", params);
    if (method === "GET" && action === "text") return chrome("page.text", params);
    if (method === "POST" && ["click", "type", "script"].includes(action)) return chrome(`page.${action}`, params);
  }
  if (method === "GET" && path === "/v1/cdp/targets") return chrome("cdp.targets");
  if (method === "GET" && path === "/v1/cdp/attached") return chrome("cdp.attached");
  if (method === "GET" && path === "/v1/cdp/protocol") return getCdpProtocol(Object.fromEntries(url.searchParams));
  if (method === "GET" && path === "/v1/cdp/events") return chrome("cdp.events", queryParams(url));
  if (method === "POST" && path === "/v1/cdp/attach") return chrome("cdp.attach", { protocolVersion: "1.3", ...body });
  if (method === "POST" && path === "/v1/cdp/detach") return chrome("cdp.detach", body);
  if (method === "POST" && path === "/v1/cdp/commands") return chrome("cdp.send", { params: {}, autoAttach: true, protocolVersion: "1.3", ...body });
  throw new HttpError(404, `No route for ${method} ${path}`);
}

async function chrome(method: string, params: Record<string, unknown> = {}) {
  const browser = selectBrowser(params.browserId);
  const chromeParams = { ...params };
  delete chromeParams.browserId;
  const id = crypto.randomUUID();
  const result = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new HttpError(504, `Timed out waiting for Chrome response to ${method}`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { browserId: browser.id, resolve, reject, timeout });
  });
  browser.socket.send(JSON.stringify({ type: "request", id, method, params: chromeParams } satisfies ChromeRequest));
  return result;
}

function getCdpProtocol(args: Record<string, unknown>) {
  const domainFilter = args.domain ? String(args.domain).toLowerCase() : null;
  const includeExperimental = stringBoolean(args.includeExperimental, true);
  const includeDeprecated = stringBoolean(args.includeDeprecated, true);
  const includeDetails = stringBoolean(args.includeDetails, false);
  const domains = cdpProtocol.domains.filter((domain) => (!domainFilter || domain.domain.toLowerCase() === domainFilter) && (includeExperimental || !domain.experimental) && (includeDeprecated || !domain.deprecated));
  return { version: cdpProtocol.version, domains: includeDetails ? domains : domains.map(summarizeProtocolDomain), domainCount: domains.length };
}

function summarizeProtocolDomain(domain: ProtocolDomain) {
  const names = (values: unknown[] = []) => values.map((value) => value && typeof value === "object" && "name" in value ? String((value as { name: unknown }).name) : String(value));
  return { domain: domain.domain, description: domain.description, experimental: domain.experimental, deprecated: domain.deprecated, dependencies: domain.dependencies, typeCount: domain.types?.length || 0, commandCount: domain.commands?.length || 0, eventCount: domain.events?.length || 0, commands: names(domain.commands), events: names(domain.events) };
}

function openApi() {
  const json = { type: "object", additionalProperties: true };
  const tabId = { name: "tabId", in: "path", required: true, schema: { type: "integer" } };
  const body = (schema: unknown, required = true) => ({ requestBody: { required, content: { "application/json": { schema } } } });
  const response = { "200": { description: "Successful Chrome response", content: { "application/json": { schema: json } } }, "503": { description: "Chrome extension unavailable" } };
  return {
    openapi: "3.1.0", info: { title: "Chrome CDP Bridge API", version: "1.0.0", description: "A local REST bridge to Chrome's chrome.debugger CDP API. The server binds to 127.0.0.1 only." },
    servers: [{ url: `http://127.0.0.1:${API_PORT}` }],
    paths: {
      "/health": { get: { summary: "Get bridge health", responses: response } },
      "/v1/tabs": { get: { summary: "List tabs", responses: response }, post: { summary: "Open a tab", ...body({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, active: { type: "boolean", default: true } } }), responses: response } },
      "/v1/tabs/{tabId}": { delete: { summary: "Close a tab", parameters: [tabId], responses: response } },
      "/v1/tabs/{tabId}/activate": { post: { summary: "Activate a tab", parameters: [tabId], responses: response } },
      "/v1/pages/{tabId}/info": { get: { summary: "Get page metadata", parameters: [tabId], responses: response } },
      "/v1/pages/{tabId}/text": { get: { summary: "Get visible page text", parameters: [tabId], responses: response } },
      "/v1/pages/{tabId}/click": { post: { summary: "Click a CSS selector", parameters: [tabId], ...body({ type: "object", required: ["selector"], properties: { selector: { type: "string" } } }), responses: response } },
      "/v1/pages/{tabId}/type": { post: { summary: "Type into a CSS selector", parameters: [tabId], ...body({ type: "object", required: ["selector", "text"], properties: { selector: { type: "string" }, text: { type: "string" }, clear: { type: "boolean", default: true } } }), responses: response } },
      "/v1/pages/{tabId}/script": { post: { summary: "Evaluate a JavaScript expression", parameters: [tabId], ...body({ type: "object", required: ["script"], properties: { script: { type: "string" } } }), responses: response } },
      "/v1/cdp/targets": { get: { summary: "List CDP targets", responses: response } },
      "/v1/cdp/attached": { get: { summary: "List attached CDP targets", responses: response } },
      "/v1/cdp/protocol": { get: { summary: "Read bundled CDP protocol metadata", parameters: [{ name: "domain", in: "query", schema: { type: "string" } }, { name: "includeDetails", in: "query", schema: { type: "boolean", default: false } }, { name: "includeExperimental", in: "query", schema: { type: "boolean", default: true } }, { name: "includeDeprecated", in: "query", schema: { type: "boolean", default: true } }], responses: response } },
      "/v1/cdp/events": { get: { summary: "Poll buffered CDP events", parameters: [{ name: "tabId", in: "query", schema: { type: "integer" } }, { name: "targetId", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", default: 100 } }, { name: "clear", in: "query", schema: { type: "boolean", default: false } }, { name: "method", in: "query", schema: { type: "string" } }], responses: response } },
      "/v1/cdp/attach": { post: { summary: "Attach Chrome debugger", ...body({ type: "object", properties: { tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" }, protocolVersion: { type: "string", default: "1.3" } } }), responses: response } },
      "/v1/cdp/detach": { post: { summary: "Detach Chrome debugger", ...body({ type: "object", properties: { tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" } } }), responses: response } },
      "/v1/cdp/commands": { post: { summary: "Send an arbitrary CDP command", description: "Use this endpoint for the full Chrome DevTools Protocol surface. The bridge auto-attaches by default.", ...body({ type: "object", required: ["command"], properties: { command: { type: "string", examples: ["Runtime.evaluate"] }, params: { type: "object", additionalProperties: true, default: {} }, tabId: { type: "integer" }, targetId: { type: "string" }, extensionId: { type: "string" }, autoAttach: { type: "boolean", default: true }, detach: { type: "boolean", default: false }, protocolVersion: { type: "string", default: "1.3" } } }), responses: response } }
    }
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > 1_000_000) throw new HttpError(413, "Request body exceeds 1 MB"); chunks.push(value); }
  if (!chunks.length) return {};
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new HttpError(400, "Request body must be a JSON object"); }
}

function numericPathId(path: string) { const value = path.match(/\/tabs\/(\d+)\/activate$/)?.[1]; if (!value) throw new HttpError(400, "Invalid tabId"); return Number(value); }
function queryParams(url: URL) { const entries: Record<string, unknown> = {}; for (const [key, value] of url.searchParams) entries[key] = key === "tabId" || key === "limit" ? Number(value) : key === "clear" ? stringBoolean(value, false) : value; return entries; }
function stringBoolean(value: unknown, fallback: boolean) { return value === undefined ? fallback : value === true || value === "true"; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function mcpTool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) { return { name, title: name, description, inputSchema: { type: "object", title: `${name}_input`, properties: { browserId: { type: "string", description: "Connected browser ID. Required when more than one browser is online." }, ...properties }, required } }; }
function mcpText(value: unknown) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }; }
function respondMcp(id: string | number, result: unknown) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function respondMcpError(id: string | number, message: string) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`); }
function serverStatus() { return { connected: browsers.size > 0, browsers: Array.from(browsers.values(), ({ id, name, connectedAt, lastSeenAt }) => ({ id, name, connectedAt, lastSeenAt })), upstreams: vibeTermMcp ? [vibeTermMcp.status()] : [], apiPort: API_PORT, bridgePort: BRIDGE_PORT, pendingRequests: pending.size, authentication: ALLOW_NO_AUTH ? "disabled" : oauthServer ? "oauth-http+psk-browser" : ALLOW_LOOPBACK_NO_AUTH ? "psk-with-loopback-bypass" : "psk", oauthIssuer: oauthServer?.issuer }; }
function registerBrowser(socket: WebSocket, id: string, name: string) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return socket.close(1008, "Invalid browserId");
  const previous = browsers.get(id);
  if (previous && previous.socket !== socket) previous.socket.close(1000, "Browser reconnected");
  const now = new Date().toISOString();
  browsers.set(id, { id, name: name.slice(0, 128), socket, connectedAt: now, lastSeenAt: now });
  socketBrowserIds.set(socket, id);
  debug("browser-connected", { browserId: id, browserName: name });
}
function selectBrowser(value: unknown) {
  const id = value ? String(value) : browsers.size === 1 ? browsers.keys().next().value : undefined;
  if (!id) throw new HttpError(409, browsers.size ? "browserId is required when multiple browsers are connected" : "No browser is connected");
  const browser = browsers.get(id);
  if (!browser || browser.socket.readyState !== WebSocket.OPEN) throw new HttpError(503, `Browser is not connected: ${id}`);
  return browser;
}
function authorize(request: IncomingMessage) {
  if (ALLOW_NO_AUTH) return;
  if (ALLOW_LOOPBACK_NO_AUTH && isDirectLoopbackRequest(request)) return;
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (oauthServer) {
    if (oauthServer.isAccessToken(supplied)) return;
    throw new HttpError(401, "Unauthorized", { "WWW-Authenticate": oauthServer.challengeHeader });
  }
  if (!PSK) throw new HttpError(503, "Unified MCP HTTP authentication is not configured");
  if (!safeEqual(supplied, PSK)) throw new HttpError(401, "Unauthorized");
}
function isDirectLoopbackRequest(request: IncomingMessage) {
  const remoteAddress = request.socket.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) return false;
  try {
    const hostname = new URL(`http://${request.headers.host || ""}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
  } catch {
    return false;
  }
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(value)); }
function sendDashboardAsset(response: ServerResponse, path: string) {
  const asset = path === "/" ? "index.html" : path.slice(1);
  const contentType = asset.endsWith(".html") ? "text/html; charset=utf-8" : asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
  try {
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }).end(readFileSync(join(PUBLIC_DIR, asset)));
  } catch {
    throw new HttpError(404, `Dashboard asset not found: ${asset}`);
  }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function debug(event: string, data: Record<string, unknown>) { try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`); } catch { /* logging must not break the bridge */ } }
class HttpError extends Error { constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); } }

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Chrome API is shutting down.")); }
  pending.clear(); for (const browser of browsers.values()) browser.socket.close(); browsers.clear(); api.close(); wss.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
