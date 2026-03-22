// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * HTTP transport for web/cloud deployment.
 *
 * Exposes:
 *   GET  /health                                  – liveness probe
 *   GET  /.well-known/oauth-authorization-server  – OAuth metadata (RFC 8414)
 *   POST /oauth/register                          – dynamic client registration
 *   GET  /oauth/authorize                         – start OAuth flow → Azure AD
 *   GET  /oauth/callback                          – Azure AD callback
 *   POST /oauth/token                             – exchange code → session token
 *   *    /mcp                                     – MCP Streamable-HTTP endpoint
 *
 * Authentication on /mcp:
 *   Every request must carry  Authorization: Bearer <session-token>
 *   where the session token was issued by POST /oauth/token.
 *   The token maps to the user's per-session ADO access token obtained via
 *   their individual Azure AD login.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getBearerHandler, WebApi } from "azure-devops-node-api";

import { logger } from "./logger.js";
import { configureAllTools } from "./tools.js";
import { DomainsManager } from "./shared/domains.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import * as oauthStore from "./oauth/store.js";
import { handleMetadata, handleRegister, handleAuthorize, handleCallback, handleToken, OAuthConfig } from "./oauth/server.js";

export interface HttpServerConfig {
  /** Default ADO organisation (overridable per-session via X-ADO-Org header at /oauth/authorize time). */
  organization: string;
  port: number;
  /** Domains to enable (default: all). */
  domains: string | string[];
  /** Comma-separated allowed CORS origins, or "*". */
  corsOrigins: string;
  oauth: OAuthConfig;
}

// ---------------------------------------------------------------------------
// Per-session MCP state
// ---------------------------------------------------------------------------

interface McpSession {
  transport: StreamableHTTPServerTransport;
}

/** MCP sessions keyed by the `Mcp-Session-Id` header value. */
const mcpSessions = new Map<string, McpSession>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string): void {
  const origin = req.headers.origin;
  if (allowedOrigins === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.split(",").map((o) => o.trim()).includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.substring(7) : undefined;
}

// ---------------------------------------------------------------------------
// MCP session creation (one per OAuth session × connect)
// ---------------------------------------------------------------------------

async function createMcpSession(adoToken: string, orgName: string, config: HttpServerConfig): Promise<StreamableHTTPServerTransport> {
  const orgUrl = `https://dev.azure.com/${orgName}`;
  const userAgentComposer = new UserAgentComposer(packageVersion);
  const tokenProvider = async (): Promise<string> => adoToken;

  const connectionProvider = async (): Promise<WebApi> =>
    new WebApi(orgUrl, getBearerHandler(adoToken), undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [{ src: "https://cdn.vsassets.io/content/icons/favicon.ico" }],
  });

  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  const domainsManager = new DomainsManager(config.domains);
  configureAllTools(server, tokenProvider, connectionProvider, () => userAgentComposer.userAgent, domainsManager.getEnabledDomains());

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, { transport });
      logger.info("MCP session created", { sessionId: sid, org: orgName });
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      mcpSessions.delete(sid);
      logger.info("MCP session closed", { sessionId: sid });
    }
  };

  await server.connect(transport);
  return transport;
}

// ---------------------------------------------------------------------------
// /mcp handler
// ---------------------------------------------------------------------------

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, config: HttpServerConfig): Promise<void> {
  // 1. Validate OAuth Bearer token → get the user's ADO token
  const bearerToken = extractBearerToken(req);
  if (!bearerToken) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Authorization header with Bearer token required" }));
    return;
  }

  const oauthSession = oauthStore.getSession(bearerToken);
  if (!oauthSession) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session token invalid or expired. Please reconnect via OAuth." }));
    return;
  }

  // 2. Route to existing MCP session or create a fresh one for this OAuth session
  const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (mcpSessionId) {
    const existing = mcpSessions.get(mcpSessionId);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP session not found or expired. Reinitialize." }));
      return;
    }
    transport = existing.transport;
  } else {
    // First request for this OAuth session – spin up a new MCP server instance
    transport = await createMcpSession(oauthSession.adoToken, oauthSession.orgName, config);
  }

  await transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function startHttpServer(config: HttpServerConfig): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    applyCorsHeaders(req, res, config.corsOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          version: packageVersion,
          organization: config.organization,
          activeMcpSessions: mcpSessions.size,
          activeOAuthSessions: oauthStore.getActiveSessionCount(),
        }),
      );
      return;
    }

    // OAuth Authorization Server endpoints
    if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      handleMetadata(req, res, config.oauth);
      return;
    }
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      await handleRegister(req, res);
      return;
    }
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      handleAuthorize(req, res, config.oauth);
      return;
    }
    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      await handleCallback(req, res, config.oauth);
      return;
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      await handleToken(req, res, config.oauth);
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      try {
        await handleMcpRequest(req, res, config);
      } catch (err) {
        logger.error("Error handling MCP request", { err });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(config.port, () => {
      logger.info("Azure DevOps MCP HTTP server started", {
        port: config.port,
        organization: config.organization,
        mcpEndpoint: `http://0.0.0.0:${config.port}/mcp`,
        healthEndpoint: `http://0.0.0.0:${config.port}/health`,
      });
      resolve();
    });
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    httpServer.close(() => {
      logger.info("HTTP server stopped");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
