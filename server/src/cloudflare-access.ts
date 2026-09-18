import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type CloudflareAccessOptions = {
  teamDomain: string;
  audience: string;
  certsUrl?: string;
  cacheTtlMs?: number;
};

export type CloudflareAccessIdentity = {
  sub?: string;
  email?: string;
  aud: string[];
  iss: string;
  exp: number;
  payload: Record<string, unknown>;
};

export class CloudflareAccessValidator {
  readonly teamDomain: string;
  readonly audience: string;
  readonly certsUrl: string;
  readonly cacheTtlMs: number;

  private cachedKeys?: {
    expiresAt: number;
    keys: Array<Record<string, unknown>>;
  };

  constructor(options: CloudflareAccessOptions) {
    this.teamDomain = options.teamDomain.replace(/\/+$/, "");
    this.audience = options.audience.trim();
    this.certsUrl = options.certsUrl || `${this.teamDomain}/cdn-cgi/access/certs`;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;

    if (!this.teamDomain || !this.audience) {
      throw new Error("Cloudflare Access team domain and audience are required");
    }

    if (
      !/^https:\/\/[^/]+\.cloudflareaccess\.com$/i.test(this.teamDomain) &&
      process.env.NODE_ENV !== "test"
    ) {
      throw new Error(
        "UNIFIED_MCP_CF_ACCESS_TEAM_DOMAIN must be an https://*.cloudflareaccess.com origin",
      );
    }
  }

  async authenticate(request: IncomingMessage): Promise<CloudflareAccessIdentity> {
    const token = String(request.headers["cf-access-jwt-assertion"] || "");
    if (!token) throw new CloudflareAccessError(401, "Cloudflare Access JWT is required");
    return this.verifyJwt(token);
  }

  async verifyJwt(token: string): Promise<CloudflareAccessIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new CloudflareAccessError(401, "Cloudflare Access JWT is malformed");

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT is malformed");
    }

    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT uses an unsupported signing algorithm");
    }

    let keys = await this.getKeys();
    let jwk = keys.find((value) => value.kid === header.kid);
    if (!jwk) {
      this.cachedKeys = undefined;
      keys = await this.getKeys();
      jwk = keys.find((value) => value.kid === header.kid);
    }
    if (!jwk || !verifyJwtSignature(parts, jwk)) {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT signature is invalid");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== this.teamDomain) {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT issuer is invalid");
    }

    const audiences = Array.isArray(payload.aud)
      ? payload.aud.map(String)
      : [String(payload.aud || "")];
    if (!audiences.includes(this.audience)) {
      throw new CloudflareAccessError(403, "Cloudflare Access JWT audience is invalid");
    }

    if (typeof payload.exp !== "number" || payload.exp <= now) {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT is expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) {
      throw new CloudflareAccessError(401, "Cloudflare Access JWT is not active yet");
    }

    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      aud: audiences,
      iss: String(payload.iss),
      exp: payload.exp,
      payload,
    };
  }

  private async getKeys(): Promise<Array<Record<string, unknown>>> {
    if (this.cachedKeys && this.cachedKeys.expiresAt > Date.now()) return this.cachedKeys.keys;

    const response = await fetch(this.certsUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new CloudflareAccessError(
        503,
        `Unable to fetch Cloudflare Access signing keys: ${response.status}`,
      );
    }

    const body = await response.json() as { keys?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.keys) || !body.keys.length) {
      throw new CloudflareAccessError(
        503,
        "Cloudflare Access signing-key response did not contain keys",
      );
    }

    this.cachedKeys = {
      expiresAt: Date.now() + this.cacheTtlMs,
      keys: body.keys,
    };
    return body.keys;
  }
}

export class CloudflareAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
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
