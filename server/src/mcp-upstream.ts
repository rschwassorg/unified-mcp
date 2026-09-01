type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

export type McpToolDefinition = {
  name: string;
  [key: string]: unknown;
};

export type UpstreamStatus = {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
  lastConnectedAt?: string;
  lastError?: string;
};

export class HttpMcpUpstream {
  private tools: McpToolDefinition[] = [];
  private connected = false;
  private lastConnectedAt?: string;
  private lastError?: string;
  private requestId = 0;

  constructor(
    readonly name: string,
    readonly url: string,
    private readonly bearerToken: string,
    private readonly timeoutMs = 5000
  ) {}

  async listTools(): Promise<McpToolDefinition[]> {
    try {
      const result = await this.request("tools/list", {});
      const tools = Array.isArray(result.tools) ? result.tools.filter(isToolDefinition) : [];
      this.tools = tools;
      this.markConnected();
    } catch (error) {
      this.markDisconnected(error);
    }
    return this.tools;
  }

  ownsTool(name: string) {
    return this.tools.some((tool) => tool.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    try {
      const result = await this.request("tools/call", { name, arguments: args });
      this.markConnected();
      return result;
    } catch (error) {
      this.markDisconnected(error);
      throw error;
    }
  }

  status(): UpstreamStatus {
    return {
      name: this.name,
      url: this.url,
      connected: this.connected,
      toolCount: this.tools.length,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`${this.name} MCP returned HTTP ${response.status}`);
    const rpc = parseMcpResponse(await response.text(), response.headers.get("content-type") || "");
    if (rpc.error) throw new Error(rpc.error.message || `${this.name} MCP request failed`);
    if (!rpc.result || typeof rpc.result !== "object") throw new Error(`${this.name} MCP returned an invalid JSON-RPC result`);
    return rpc.result;
  }

  private markConnected() {
    this.connected = true;
    this.lastConnectedAt = new Date().toISOString();
    this.lastError = undefined;
  }

  private markDisconnected(error: unknown) {
    this.connected = false;
    this.lastError = error instanceof Error ? error.message : String(error);
  }
}

function parseMcpResponse(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .reverse()
      .find((line) => line && line !== "[DONE]");
    if (!data) throw new Error("MCP event stream contained no response");
    return JSON.parse(data) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  return Boolean(value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string");
}
