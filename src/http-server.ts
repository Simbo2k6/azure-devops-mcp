// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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

export interface HttpServerConfig {
  /** Default Azure DevOps organization name (overridable per-request via X-ADO-Org header) */
  organization: string;
  /** Port to listen on */
  port: number;
  /** Fallback token provider when no per-request token is supplied */
  fallbackTokenProvider: () => Promise<string>;
  /** Domains to enable (default: all) */
  domains: string | string[];
  /** Allowed CORS origins, "*" for any (default) */
  corsOrigins: string;
}

interface SessionData {
  transport: StreamableHTTPServerTransport;
}

/** In-memory session store: sessionId → transport */
const sessions = new Map<string, SessionData>();

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ADO-Token, X-ADO-Org, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function getTokenFromRequest(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.substring(7);
  return (req.headers["x-ado-token"] as string | undefined) || undefined;
}

function getOrgFromRequest(req: IncomingMessage, defaultOrg: string): string {
  return (req.headers["x-ado-org"] as string | undefined) || defaultOrg;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Creates a new per-session McpServer + StreamableHTTPServerTransport pair.
 * Auth credentials are captured at session-creation time from the incoming
 * request (Authorization / X-ADO-Token header) or fall back to the server-wide
 * token provider.
 */
async function createSession(req: IncomingMessage, config: HttpServerConfig): Promise<StreamableHTTPServerTransport> {
  const requestToken = getTokenFromRequest(req);
  const tokenProvider: () => Promise<string> = requestToken ? async () => requestToken : config.fallbackTokenProvider;

  const orgName = getOrgFromRequest(req, config.organization);
  const orgUrl = `https://dev.azure.com/${orgName}`;

  const userAgentComposer = new UserAgentComposer(packageVersion);

  const connectionProvider = async (): Promise<WebApi> => {
    const token = await tokenProvider();
    return new WebApi(orgUrl, getBearerHandler(token), undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
  };

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [{ src: "https://cdn.vsassets.io/content/icons/favicon.ico" }],
  });

  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  const domainsManager = new DomainsManager(config.domains);
  const enabledDomains = domainsManager.getEnabledDomains();
  configureAllTools(server, tokenProvider, connectionProvider, () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport });
      logger.info("MCP session initialized", { sessionId, org: orgName });
    },
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) {
      sessions.delete(sessionId);
      logger.info("MCP session closed", { sessionId });
    }
  };

  await server.connect(transport);
  return transport;
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, config: HttpServerConfig): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId) {
    // Route to existing session
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found or expired. Please reinitialize." }));
      return;
    }
    transport = session.transport;
  } else {
    // No session ID → initialize a new session
    transport = await createSession(req, config);
  }

  await transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function startHttpServer(config: HttpServerConfig): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    applyCorsHeaders(req, res, config.corsOrigins);

    // Preflight
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
          activeSessions: sessions.size,
          transport: "streamable-http",
        }),
      );
      return;
    }

    // MCP endpoint (all methods: POST for messages, GET for SSE stream, DELETE for session termination)
    if (url.pathname === "/mcp") {
      try {
        await handleMcpRequest(req, res, config);
      } catch (error) {
        logger.error("Error handling MCP request", { error });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // Unknown path
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
