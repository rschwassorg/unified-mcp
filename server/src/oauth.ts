import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { URL } from "node:url";

type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientSecretHash?: string;
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  applicationType?: string;
  registeredAt: number;
};

type OAuthTokenRecord = {
  clientId: string;
  scope: string;
  expiresAt: number;
};

type OAuthState = {
  clients: Record<string, OAuthClient>;
  accessTokens: Record<string, OAuthTokenRecord>;
  refreshTokens: Record<string, OAuthTokenRecord>;
};

type PendingAuthorization = {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
};

type AuthorizationCode = PendingAuthorization & {
  used: boolean;
};

export type OAuthServerOptions = {
  issuer: string;
  resource: string;
  stateFile: string;
  allowedRedirectHosts?: string[];
  cloudflareAccessTeamDomain?: string;
  cloudflareAccessAudience?: string;
  accessTokenLifetimeSeconds?: number;
  refreshTokenLifetimeSeconds?: number;
};

const SUPPORTED_SCOPES = new Set(["mcp", "offline_access"]);
const SUPPORTED_TOKEN_AUTH_METHODS = new Set<TokenEndpointAuthMethod>([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

export class UnifiedMcpOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly stateFile: string;
  readonly allowedRedirectHosts: string[];
  readonly cloudflareAccessTeamDomain?: string;
  readonly cloudflareAccessAudience?: string;
  readonly accessTokenLifetimeSeconds: number;
  readonly refreshTokenLifetimeSeconds: number;

  private oauthState: OAuthState;
  private cloudflareKeys?: { expiresAt: number; keys: Array<Record<string, unknown>> };
  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  private authorizationCodes = new Map<string, AuthorizationCode>();

  constructor(options: OAuthServerOptions) {
    this.issuer = stripTrailingSlash(options.issuer);
    this.resource = options.resource;
    this.stateFile = options.stateFile;
    this.allowedRedirectHosts = (options.allowedRedirectHosts ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    this.cloudflareAccessTeamDomain = options.cloudflareAccessTeamDomain
      ? stripTrailingSlash(options.cloudflareAccessTeamDomain)
      : undefined;
    this.cloudflareAccessAudience = options.cloudflareAccessAudience?.trim() || undefined;
    this.accessTokenLifetimeSeconds = options.accessTokenLifetimeSeconds ?? 3600;
    this.refreshTokenLifetimeSeconds = options.refreshTokenLifetimeSeconds ?? 30 * 24 * 60 * 60;

    if (!/^https:\/\//i.test(this.issuer) && !isLoopbackUrl(this.issuer)) {
      throw new Error("UNIFIED_MCP_OAUTH_ISSUER must use HTTPS unless it is a loopback development URL");
    }
    if (!isLoopbackUrl(this.issuer) && (!this.cloudflareAccessTeamDomain || !this.cloudflareAccessAudience)) {
      throw new Error("Production OAuth requires UNIFIED_MCP_OAUTH_CF_ACCESS_TEAM_DOMAIN and UNIFIED_MCP_OAUTH_CF_ACCESS_AUD");
    }
    if (this.cloudflareAccessTeamDomain && !/^https:\/\/[^/]+\.cloudflareaccess\.com$/i.test(this.cloudflareAccessTeamDomain)) {
      throw new Error("UNIFIED_MCP_OAUTH_CF_ACCESS_TEAM_DOMAIN must be an https://*.cloudflareaccess.com origin");
    }
    this.oauthState = this.loadState();
    this.cleanupPersistentState();
  }

  get resourceMetadataUrl() {
    const resourceUrl = new URL(this.resource);
    return `${this.issuer}/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
  }

  get challengeHeader() {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"`;
  }

  isAccessToken(token: string): boolean {
    if (!token) return false;
    const record = this.oauthState.accessTokens[tokenHash(token)];
    if (!record) return false;
    if (record.expiresAt <= Date.now()) {
      delete this.oauthState.accessTokens[tokenHash(token)];
      this.persistState();
      return false;
    }
    return true;
  }

  async handlePublicEndpoint(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      this.sendJson(
        response,
        200,
        {
          resource: this.resource,
          authorization_servers: [this.issuer],
          scopes_supported: [...SUPPORTED_SCOPES],
          bearer_methods_supported: ["header"],
        },
        { "Access-Control-Allow-Origin": "*" },
      );
      return true;
    }

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      this.sendJson(
        response,
        200,
        {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          registration_endpoint: `${this.issuer}/register`,
          revocation_endpoint: `${this.issuer}/revoke`,
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: [...SUPPORTED_TOKEN_AUTH_METHODS],
          scopes_supported: [...SUPPORTED_SCOPES],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        },
        { "Access-Control-Allow-Origin": "*" },
      );
      return true;
    }

    if (url.pathname === "/register") {
      if (request.method !== "POST") {
        this.sendOAuthError(response, 405, "invalid_request", "Client registration uses POST");
        return true;
      }
      await this.handleRegistration(request, response);
      return true;
    }

    if (url.pathname === "/authorize") {
      let identity: string | undefined;
      try {
        identity = await this.authenticateAuthorizationUser(request);
      } catch (error) {
        const status = error instanceof OAuthHttpError ? error.status : 403;
        this.sendHtml(response, status, authPage(errorMessage(error)));
        return true;
      }
      if (request.method === "GET") {
        this.handleAuthorizationStart(response, url, identity);
        return true;
      }
      if (request.method === "POST") {
        await this.handleAuthorizationDecision(request, response, identity);
        return true;
      }
      response.writeHead(405, { Allow: "GET, POST" }).end();
      return true;
    }

    if (url.pathname === "/token") {
      if (request.method !== "POST") {
        this.sendOAuthError(response, 405, "invalid_request", "Token exchange uses POST");
        return true;
      }
      await this.handleToken(request, response);
      return true;
    }

    if (url.pathname === "/revoke") {
      if (request.method !== "POST") {
        this.sendOAuthError(response, 405, "invalid_request", "Token revocation uses POST");
        return true;
      }
      await this.handleRevocation(request, response);
      return true;
    }

    return false;
  }

  private async authenticateAuthorizationUser(request: IncomingMessage): Promise<string | undefined> {
    if (isLoopbackUrl(this.issuer)) return undefined;

    const token = String(request.headers["cf-access-jwt-assertion"] || "");
    if (!token) throw new OAuthHttpError(403, "Cloudflare Access JWT is required for OAuth authorization");

    const parts = token.split(".");
    if (parts.length !== 3) throw new OAuthHttpError(403, "Cloudflare Access JWT is malformed");

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new OAuthHttpError(403, "Cloudflare Access JWT is malformed");
    }

    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new OAuthHttpError(403, "Cloudflare Access JWT uses an unsupported signing algorithm");
    }

    const keys = await this.getCloudflareAccessKeys();
    const jwk = keys.find((value) => value.kid === header.kid);
    if (!jwk) {
      this.cloudflareKeys = undefined;
      const refreshed = await this.getCloudflareAccessKeys();
      const retryKey = refreshed.find((value) => value.kid === header.kid);
      if (!retryKey) throw new OAuthHttpError(403, "Cloudflare Access signing key is unknown");
      if (!verifyJwtSignature(parts, retryKey)) throw new OAuthHttpError(403, "Cloudflare Access JWT signature is invalid");
    } else if (!verifyJwtSignature(parts, jwk)) {
      throw new OAuthHttpError(403, "Cloudflare Access JWT signature is invalid");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== this.cloudflareAccessTeamDomain) {
      throw new OAuthHttpError(403, "Cloudflare Access JWT issuer is invalid");
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || "")];
    if (!this.cloudflareAccessAudience || !audiences.includes(this.cloudflareAccessAudience)) {
      throw new OAuthHttpError(403, "Cloudflare Access JWT audience is invalid");
    }
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      throw new OAuthHttpError(403, "Cloudflare Access JWT is expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) {
      throw new OAuthHttpError(403, "Cloudflare Access JWT is not active yet");
    }

    return typeof payload.email === "string"
      ? payload.email
      : typeof payload.sub === "string"
        ? payload.sub
        : "Cloudflare Access user";
  }

  private async getCloudflareAccessKeys(): Promise<Array<Record<string, unknown>>> {
    if (this.cloudflareKeys && this.cloudflareKeys.expiresAt > Date.now()) return this.cloudflareKeys.keys;
    const response = await fetch(`${this.cloudflareAccessTeamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new OAuthHttpError(503, `Unable to fetch Cloudflare Access signing keys: ${response.status}`);
    const body = await response.json() as { keys?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.keys) || !body.keys.length) {
      throw new OAuthHttpError(503, "Cloudflare Access signing-key response did not contain keys");
    }
    this.cloudflareKeys = { expiresAt: Date.now() + 5 * 60 * 1000, keys: body.keys };
    return body.keys;
  }

  private async handleRegistration(request: IncomingMessage, response: ServerResponse) {
    const body = await readJsonBody(request);
    const redirectUris = stringArray(body.redirect_uris);
    if (!redirectUris.length) {
      return this.sendOAuthError(response, 400, "invalid_client_metadata", "redirect_uris is required");
    }
    try {
      for (const redirectUri of redirectUris) this.validateRedirectUri(redirectUri);
    } catch (error) {
      return this.sendOAuthError(response, 400, "invalid_redirect_uri", errorMessage(error));
    }

    this.cleanupPersistentState();
    if (Object.keys(this.oauthState.clients).length >= 200) {
      return this.sendOAuthError(response, 429, "invalid_client_metadata", "Client registration limit reached");
    }

    const requestedMethod = String(body.token_endpoint_auth_method || "none") as TokenEndpointAuthMethod;
    const tokenEndpointAuthMethod = SUPPORTED_TOKEN_AUTH_METHODS.has(requestedMethod)
      ? requestedMethod
      : "none";
    const clientId = randomToken(24);
    const clientSecret = tokenEndpointAuthMethod === "none" ? undefined : randomToken(32);
    const scope = normalizeScope(body.scope);
    const client: OAuthClient = {
      clientId,
      clientName: String(body.client_name || "MCP client").slice(0, 200),
      redirectUris,
      tokenEndpointAuthMethod,
      clientSecretHash: clientSecret ? tokenHash(clientSecret) : undefined,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scope,
      applicationType: typeof body.application_type === "string" ? body.application_type : undefined,
      registeredAt: Date.now(),
    };
    this.oauthState.clients[clientId] = client;
    this.persistState();

    this.sendJson(
      response,
      201,
      {
        client_id: clientId,
        ...(clientSecret
          ? {
              client_secret: clientSecret,
              client_secret_expires_at: 0,
            }
          : {}),
        client_id_issued_at: Math.floor(client.registeredAt / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        scope: client.scope,
        ...(client.applicationType ? { application_type: client.applicationType } : {}),
      },
      { "Cache-Control": "no-store" },
    );
  }

  private handleAuthorizationStart(response: ServerResponse, url: URL, identity?: string) {
    this.cleanupEphemeralState();

    const responseType = url.searchParams.get("response_type") || "";
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
    const state = url.searchParams.get("state") || undefined;
    const requestedResource = url.searchParams.get("resource");
    const scope = normalizeScope(url.searchParams.get("scope"));

    const client = this.oauthState.clients[clientId];
    if (!client) return this.sendHtml(response, 400, authPage("Unknown OAuth client."));
    if (responseType !== "code") return this.redirectOAuthError(response, redirectUri, state, "unsupported_response_type");
    if (!client.redirectUris.includes(redirectUri)) return this.sendHtml(response, 400, authPage("The redirect URI is not registered for this client."));
    if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return this.redirectOAuthError(response, redirectUri, state, "invalid_request", "PKCE S256 is required.");
    }
    if (requestedResource && requestedResource !== this.resource) {
      return this.redirectOAuthError(response, redirectUri, state, "invalid_target", "Unexpected resource.");
    }
    try {
      validateScope(scope);
    } catch (error) {
      return this.redirectOAuthError(response, redirectUri, state, "invalid_scope", errorMessage(error));
    }

    const transaction = randomToken(24);
    this.pendingAuthorizations.set(transaction, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scope,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    this.sendHtml(
      response,
      200,
      authorizationPage({
        transaction,
        clientName: client.clientName,
        redirectUri,
        scope,
        identity,
      }),
    );
  }

  private async handleAuthorizationDecision(request: IncomingMessage, response: ServerResponse, identity?: string) {
    this.cleanupEphemeralState();
    const form = await readFormBody(request);
    const transaction = form.get("transaction") || "";
    const pending = this.pendingAuthorizations.get(transaction);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingAuthorizations.delete(transaction);
      return this.sendHtml(response, 400, authPage("This authorization request expired. Start the connection again."));
    }

    const client = this.oauthState.clients[pending.clientId];
    if (!client) {
      this.pendingAuthorizations.delete(transaction);
      return this.sendHtml(response, 400, authPage("The OAuth client is no longer registered."));
    }

    if ((form.get("action") || "") === "deny") {
      this.pendingAuthorizations.delete(transaction);
      return this.redirectOAuthError(response, pending.redirectUri, pending.state, "access_denied");
    }

    if (!identity && !isLoopbackUrl(this.issuer)) {
      return this.sendHtml(response, 403, authPage("Cloudflare Access authentication is required."));
    }

    this.pendingAuthorizations.delete(transaction);
    const code = randomToken(32);
    this.authorizationCodes.set(code, {
      ...pending,
      used: false,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.issuer);
    response.writeHead(302, {
      Location: redirect.toString(),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    }).end();
  }

  private async handleToken(request: IncomingMessage, response: ServerResponse) {
    this.cleanupEphemeralState();
    this.cleanupPersistentState();

    const form = await readFormBody(request);
    const client = this.authenticateTokenClient(request, form, response);
    if (!client) return;

    const grantType = form.get("grant_type") || "";
    if (grantType === "authorization_code") {
      const code = form.get("code") || "";
      const record = this.authorizationCodes.get(code);
      this.authorizationCodes.delete(code);
      if (!record || record.used || record.expiresAt <= Date.now()) {
        return this.sendOAuthError(response, 400, "invalid_grant", "Authorization code is invalid or expired");
      }
      if (record.clientId !== client.clientId) {
        return this.sendOAuthError(response, 400, "invalid_grant", "Authorization code belongs to another client");
      }
      if ((form.get("redirect_uri") || "") !== record.redirectUri) {
        return this.sendOAuthError(response, 400, "invalid_grant", "redirect_uri does not match the authorization request");
      }
      const verifier = form.get("code_verifier") || "";
      if (!verifier || pkceChallenge(verifier) !== record.codeChallenge) {
        return this.sendOAuthError(response, 400, "invalid_grant", "PKCE verification failed");
      }
      return this.issueTokens(response, client.clientId, record.scope);
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") || "";
      const refreshHash = tokenHash(refreshToken);
      const record = this.oauthState.refreshTokens[refreshHash];
      if (!record || record.expiresAt <= Date.now() || record.clientId !== client.clientId) {
        delete this.oauthState.refreshTokens[refreshHash];
        this.persistState();
        return this.sendOAuthError(response, 400, "invalid_grant", "Refresh token is invalid or expired");
      }

      let scope = record.scope;
      const requestedScope = form.get("scope");
      if (requestedScope) {
        const normalized = normalizeScope(requestedScope);
        try {
          validateScope(normalized);
        } catch (error) {
          return this.sendOAuthError(response, 400, "invalid_scope", errorMessage(error));
        }
        if (!isScopeSubset(normalized, record.scope)) {
          return this.sendOAuthError(response, 400, "invalid_scope", "Refresh scope cannot exceed the original grant");
        }
        scope = normalized;
      }

      delete this.oauthState.refreshTokens[refreshHash];
      return this.issueTokens(response, client.clientId, scope);
    }

    return this.sendOAuthError(response, 400, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token");
  }

  private async handleRevocation(request: IncomingMessage, response: ServerResponse) {
    const form = await readFormBody(request);
    const token = form.get("token") || "";
    if (token) {
      const hash = tokenHash(token);
      delete this.oauthState.accessTokens[hash];
      delete this.oauthState.refreshTokens[hash];
      this.persistState();
    }
    response.writeHead(200, { "Cache-Control": "no-store" }).end();
  }

  private authenticateTokenClient(
    request: IncomingMessage,
    form: URLSearchParams,
    response: ServerResponse,
  ): OAuthClient | undefined {
    const basic = parseBasicAuth(String(request.headers.authorization || ""));
    const bodyClientId = form.get("client_id") || "";
    const clientId = basic?.clientId || bodyClientId;
    const client = this.oauthState.clients[clientId];
    if (!client) {
      this.sendOAuthError(response, 401, "invalid_client", "Unknown OAuth client");
      return undefined;
    }

    if (client.tokenEndpointAuthMethod === "none") {
      if (!bodyClientId || bodyClientId !== client.clientId) {
        this.sendOAuthError(response, 401, "invalid_client", "client_id is required");
        return undefined;
      }
      return client;
    }

    const suppliedSecret =
      client.tokenEndpointAuthMethod === "client_secret_basic"
        ? basic?.clientSecret || ""
        : form.get("client_secret") || "";
    if (!client.clientSecretHash || tokenHash(suppliedSecret) !== client.clientSecretHash) {
      this.sendOAuthError(response, 401, "invalid_client", "Client authentication failed");
      return undefined;
    }
    return client;
  }

  private issueTokens(response: ServerResponse, clientId: string, scope: string) {
    const now = Date.now();
    const accessToken = randomToken(32);
    const refreshToken = randomToken(48);
    this.oauthState.accessTokens[tokenHash(accessToken)] = {
      clientId,
      scope,
      expiresAt: now + this.accessTokenLifetimeSeconds * 1000,
    };
    this.oauthState.refreshTokens[tokenHash(refreshToken)] = {
      clientId,
      scope,
      expiresAt: now + this.refreshTokenLifetimeSeconds * 1000,
    };
    this.persistState();

    this.sendJson(
      response,
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.accessTokenLifetimeSeconds,
        refresh_token: refreshToken,
        scope,
      },
      {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    );
  }

  private validateRedirectUri(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("redirect_uri must be an absolute URL");
    }

    const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("redirect_uri must use HTTPS, except for loopback development clients");
    }
    if (url.username || url.password || url.hash) {
      throw new Error("redirect_uri cannot contain credentials or a fragment");
    }
    if (!loopback && !this.allowedRedirectHosts.length) {
      throw new Error("Non-loopback redirect_uri values require UNIFIED_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS");
    }
    if (!loopback && !hostAllowed(url.hostname, this.allowedRedirectHosts)) {
      throw new Error(`redirect_uri host is not allowed: ${url.hostname}`);
    }
  }

  private redirectOAuthError(
    response: ServerResponse,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description?: string,
  ) {
    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      return this.sendHtml(response, 400, authPage(description || error));
    }
    redirect.searchParams.set("error", error);
    if (description) redirect.searchParams.set("error_description", description);
    if (state) redirect.searchParams.set("state", state);
    redirect.searchParams.set("iss", this.issuer);
    response.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" }).end();
  }

  private cleanupEphemeralState() {
    const now = Date.now();
    for (const [key, value] of this.pendingAuthorizations) {
      if (value.expiresAt <= now) this.pendingAuthorizations.delete(key);
    }
    for (const [key, value] of this.authorizationCodes) {
      if (value.expiresAt <= now || value.used) this.authorizationCodes.delete(key);
    }
  }

  private cleanupPersistentState() {
    const now = Date.now();
    let changed = false;
    for (const [key, value] of Object.entries(this.oauthState.accessTokens)) {
      if (value.expiresAt <= now) {
        delete this.oauthState.accessTokens[key];
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(this.oauthState.refreshTokens)) {
      if (value.expiresAt <= now) {
        delete this.oauthState.refreshTokens[key];
        changed = true;
      }
    }
    if (changed) this.persistState();
  }

  private loadState(): OAuthState {
    if (!existsSync(this.stateFile)) {
      return { clients: {}, accessTokens: {}, refreshTokens: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8").replace(/^\uFEFF/, "")) as Partial<OAuthState>;
      return {
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
      };
    } catch (error) {
      throw new Error(`Unable to read OAuth state at ${this.stateFile}: ${errorMessage(error)}`);
    }
  }

  private persistState() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(this.oauthState, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private sendOAuthError(
    response: ServerResponse,
    status: number,
    error: string,
    description?: string,
  ) {
    this.sendJson(
      response,
      status,
      { error, ...(description ? { error_description: description } : {}) },
      {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    );
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
  ) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    }).end(JSON.stringify(value));
  }

  private sendHtml(response: ServerResponse, status: number, html: string) {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }).end(html);
  }
}

async function readBody(request: IncomingMessage, maxBytes = 256_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new Error("OAuth request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readBody(request)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}

function normalizeScope(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value : "mcp";
  return [...new Set(raw.split(/\s+/).filter(Boolean))].join(" ");
}

function validateScope(scope: string) {
  for (const item of scope.split(/\s+/).filter(Boolean)) {
    if (!SUPPORTED_SCOPES.has(item)) throw new Error(`Unsupported scope: ${item}`);
  }
}

function isScopeSubset(requested: string, granted: string) {
  const allowed = new Set(granted.split(/\s+/).filter(Boolean));
  return requested.split(/\s+/).filter(Boolean).every((value) => allowed.has(value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

function parseBasicAuth(header: string): { clientId: string; clientSecret: string } | undefined {
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return undefined;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function hostAllowed(hostname: string, allowedHosts: string[]) {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
}

function randomToken(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function verifyJwtSignature(parts: string[], jwk: Record<string, unknown>) {
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      key,
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    return false;
  }
}

class OAuthHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] || character));
}

function authPage(message: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unified MCP OAuth</title>
<style>
body{font:16px system-ui,sans-serif;background:#f5f5f5;color:#171717;margin:0}
main{max-width:640px;margin:8vh auto;background:white;padding:32px;border-radius:14px;box-shadow:0 8px 35px #0001}
h1{margin-top:0}p{line-height:1.5}
</style>
</head>
<body><main><h1>Unified MCP OAuth</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function authorizationPage(input: {
  transaction: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  identity?: string;
}) {
  const target = new URL(input.redirectUri);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Unified MCP</title>
<style>
body{font:16px system-ui,sans-serif;background:#f5f5f5;color:#171717;margin:0}
main{max-width:640px;margin:7vh auto;background:white;padding:32px;border-radius:14px;box-shadow:0 8px 35px #0001}
h1{margin-top:0}.meta{background:#f3f4f6;padding:14px;border-radius:8px;overflow-wrap:anywhere}
input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #aaa;border-radius:7px}
.actions{display:flex;gap:10px;margin-top:24px}button{padding:10px 18px;border:0;border-radius:7px;cursor:pointer}
.approve{background:#111;color:#fff}.deny{background:#ddd}
</style>
</head>
<body>
<main>
<h1>Authorize Unified MCP</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> is requesting access to Unified MCP.</p>
${input.identity ? `<p>Signed in through Cloudflare Access as <strong>${escapeHtml(input.identity)}</strong>.</p>` : ""}
<div class="meta"><strong>Redirect:</strong> ${escapeHtml(target.origin)}<br><strong>Scopes:</strong> ${escapeHtml(input.scope)}</div>
<form method="post" action="/authorize">
<input type="hidden" name="transaction" value="${escapeHtml(input.transaction)}">
<div class="actions">
<button class="approve" type="submit" name="action" value="approve">Authorize</button>
<button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
</div>
</form>
</main>
</body>
</html>`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
