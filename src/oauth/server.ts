// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OAuth 2.0 Authorization Server endpoints.
 *
 * This module makes the MCP server act as an OAuth 2.0 AS that proxies
 * authentication to Azure AD (IBT tenant) and issues short-lived session
 * tokens to MCP clients (Claude.ai, etc.).
 *
 * Endpoints implemented:
 *   GET  /.well-known/oauth-authorization-server  – RFC 8414 metadata
 *   POST /oauth/register                          – RFC 7591 dynamic registration
 *   GET  /oauth/authorize                         – redirect to Azure AD
 *   GET  /oauth/callback                          – Azure AD callback; issue MCP code
 *   POST /oauth/token                             – exchange code → session token
 */

import { createHash, randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";

import { logger } from "../logger.js";
import * as store from "./store.js";

// Azure DevOps resource scope
const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

export interface OAuthConfig {
  /** Public base URL of this server, e.g. https://ado-mcp.example.com */
  baseUrl: string;
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  /** Default ADO organisation used when creating MCP sessions. */
  defaultOrg: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read request body and parse as JSON or URL-encoded form. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const result: Record<string, string> = {};
        new URLSearchParams(raw).forEach((v, k) => {
          result[k] = v;
        });
        resolve(result);
      } else {
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      }
    });
    req.on("error", reject);
  });
}

function oauthError(res: ServerResponse, status: number, error: string, description?: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    return createHash("sha256").update(verifier).digest("base64url") === challenge;
  }
  return method === "plain" && verifier === challenge;
}

// ---------------------------------------------------------------------------
// GET /.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------

export function handleMetadata(_req: IncomingMessage, res: ServerResponse, config: OAuthConfig): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      issuer: config.baseUrl,
      authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
      token_endpoint: `${config.baseUrl}/oauth/token`,
      registration_endpoint: `${config.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    }),
  );
}

// ---------------------------------------------------------------------------
// POST /oauth/register  (RFC 7591 dynamic client registration)
// ---------------------------------------------------------------------------

export async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const redirectUris = body["redirect_uris"];

  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
    return oauthError(res, 400, "invalid_request", "redirect_uris must be a non-empty array of strings");
  }

  const client = store.registerClient(redirectUris as string[]);
  logger.info("OAuth client registered", { clientId: client.clientId });

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  );
}

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

export function handleAuthorize(req: IncomingMessage, res: ServerResponse, config: OAuthConfig): void {
  const url = new URL(req.url!, "http://localhost");
  const p = url.searchParams;

  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const responseType = p.get("response_type");
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
  const clientState = p.get("state") ?? "";

  if (responseType !== "code") return oauthError(res, 400, "unsupported_response_type");
  if (!clientId || !redirectUri || !codeChallenge) return oauthError(res, 400, "invalid_request", "Missing required parameters");

  const client = store.getClient(clientId);
  if (!client) return oauthError(res, 400, "invalid_client", "Unknown client_id");
  if (!client.redirectUris.includes(redirectUri)) return oauthError(res, 400, "invalid_request", "redirect_uri not registered");

  // Store the OAuth request details keyed by a UUID we'll send to Azure AD as `state`
  const azureState = randomUUID();
  store.storePendingAuthorization(azureState, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    clientState,
    createdAt: Date.now(),
  });

  // Build Azure AD authorization URL
  const azureUrl = new URL(`https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/authorize`);
  azureUrl.searchParams.set("client_id", config.azureClientId);
  azureUrl.searchParams.set("response_type", "code");
  azureUrl.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/callback`);
  azureUrl.searchParams.set("scope", `${ADO_SCOPE} offline_access`);
  azureUrl.searchParams.set("state", azureState);
  azureUrl.searchParams.set("prompt", "select_account");

  res.writeHead(302, { Location: azureUrl.toString() });
  res.end();
}

// ---------------------------------------------------------------------------
// GET /oauth/callback  (Azure AD redirects here after user login)
// ---------------------------------------------------------------------------

export async function handleCallback(req: IncomingMessage, res: ServerResponse, config: OAuthConfig): Promise<void> {
  const url = new URL(req.url!, "http://localhost");
  const code = url.searchParams.get("code");
  const azureState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    logger.error("Azure AD returned error on callback", {
      error,
      description: url.searchParams.get("error_description"),
    });
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Authentication failed: ${error}. Please try connecting again.`);
    return;
  }

  if (!code || !azureState) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing code or state parameter.");
    return;
  }

  const pending = store.consumePendingAuthorization(azureState);
  if (!pending) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Authorization request not found or expired. Please try connecting again.");
    return;
  }

  // Exchange Azure AD authorization code for an ADO access token (server-side)
  let adoToken: string;
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.azureClientId,
        client_secret: config.azureClientSecret,
        code,
        redirect_uri: `${config.baseUrl}/oauth/callback`,
        grant_type: "authorization_code",
        scope: `${ADO_SCOPE} offline_access`,
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;
    if (!tokenRes.ok || !tokenData["access_token"]) {
      throw new Error(str(tokenData["error_description"]) ?? str(tokenData["error"]) ?? "Token exchange failed");
    }
    adoToken = tokenData["access_token"] as string;
  } catch (err) {
    logger.error("Azure AD token exchange failed", { err });
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to obtain Azure DevOps token. Please try again.");
    return;
  }

  // Issue a short-lived MCP authorization code and redirect back to the client
  const mcpCode = randomUUID();
  store.storeAuthCode(mcpCode, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    adoToken,
    createdAt: Date.now(),
  });

  const clientRedirect = new URL(pending.redirectUri);
  clientRedirect.searchParams.set("code", mcpCode);
  if (pending.clientState) clientRedirect.searchParams.set("state", pending.clientState);

  logger.info("OAuth authorization completed, redirecting to client", { clientId: pending.clientId });
  res.writeHead(302, { Location: clientRedirect.toString() });
  res.end();
}

// ---------------------------------------------------------------------------
// POST /oauth/token
// ---------------------------------------------------------------------------

export async function handleToken(req: IncomingMessage, res: ServerResponse, config: OAuthConfig): Promise<void> {
  const body = await readBody(req);

  const grantType = str(body["grant_type"]);
  const code = str(body["code"]);
  const redirectUri = str(body["redirect_uri"]);
  const clientId = str(body["client_id"]);
  const clientSecret = str(body["client_secret"]);
  const codeVerifier = str(body["code_verifier"]);

  if (grantType !== "authorization_code") return oauthError(res, 400, "unsupported_grant_type");
  if (!code || !clientId || !codeVerifier) return oauthError(res, 400, "invalid_request", "Missing required parameters");

  const client = store.getClient(clientId);
  if (!client || client.clientSecret !== clientSecret) return oauthError(res, 401, "invalid_client", "Client authentication failed");

  const authCode = store.consumeAuthCode(code);
  if (!authCode) return oauthError(res, 400, "invalid_grant", "Authorization code not found or expired");
  if (authCode.clientId !== clientId) return oauthError(res, 400, "invalid_grant", "Client mismatch");
  if (redirectUri && authCode.redirectUri !== redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
  if (!verifyPkce(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
    return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
  }

  const sessionToken = store.createSession(authCode.adoToken, config.defaultOrg);
  logger.info("OAuth session token issued", { clientId });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      access_token: sessionToken,
      token_type: "bearer",
      expires_in: 3600,
    }),
  );
}
