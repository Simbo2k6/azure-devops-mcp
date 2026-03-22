#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { startHttpServer } from "./http-server.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name (can also be set via ADO_ORG env var)",
      type: "string",
      demandOption: false,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar"],
    default: defaultAuthenticationType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .option("transport", {
    describe: "Transport mode: 'stdio' for local MCP clients, 'http' for web/cloud deployment",
    type: "string",
    choices: ["stdio", "http"],
    default: "stdio",
  })
  .option("port", {
    alias: "p",
    describe: "HTTP server port (only used when --transport=http)",
    type: "number",
    default: 3000,
  })
  .option("cors-origins", {
    describe: "Allowed CORS origins for HTTP transport, comma-separated. Use '*' to allow all origins.",
    type: "string",
    default: "*",
  })
  .help()
  .parseSync();

// Organization can be provided as CLI arg or via ADO_ORG environment variable
export const orgName = (argv.organization as string | undefined) ?? process.env.ADO_ORG ?? "";
const orgUrl = "https://dev.azure.com/" + orgName;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    const authHandler = getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function runStdio() {
  if (!orgName) {
    logger.error("Organization name is required. Pass it as a positional argument or set the ADO_ORG environment variable.");
    process.exit(1);
  }

  logger.info("Starting Azure DevOps MCP Server (stdio)", {
    organization: orgName,
    organizationUrl: orgUrl,
    authentication: argv.authentication,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
  });

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };
  const tenantId = (await getOrgTenant(orgName)) ?? argv.tenant;
  const authenticator = createAuthenticator(argv.authentication, tenantId);

  // removing prompts untill further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer), () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp() {
  if (!orgName) {
    logger.error("Organization name is required. Pass it as a positional argument or set the ADO_ORG environment variable.");
    process.exit(1);
  }

  // OAuth config is mandatory in HTTP mode – read from environment variables
  const azureTenantId = process.env.AZURE_TENANT_ID;
  const azureClientId = process.env.AZURE_CLIENT_ID;
  const azureClientSecret = process.env.AZURE_CLIENT_SECRET;
  const mcpBaseUrl = (process.env.MCP_BASE_URL ?? "").replace(/\/$/, ""); // strip trailing slash

  if (!azureTenantId || !azureClientId || !azureClientSecret || !mcpBaseUrl) {
    logger.error("HTTP mode requires the following environment variables: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, MCP_BASE_URL");
    process.exit(1);
  }

  // Honour PORT env var so cloud platforms (Azure Container Apps, etc.) can inject the port
  const port = argv.port !== 3000 ? (argv.port as number) : parseInt(process.env.PORT ?? "3000", 10);

  logger.info("Starting Azure DevOps MCP Server (HTTP)", {
    organization: orgName,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    port,
    baseUrl: mcpBaseUrl,
    corsOrigins: argv["cors-origins"],
    version: packageVersion,
  });

  await startHttpServer({
    organization: orgName,
    port,
    domains: argv.domains,
    corsOrigins: argv["cors-origins"] as string,
    oauth: {
      baseUrl: mcpBaseUrl,
      azureTenantId,
      azureClientId,
      azureClientSecret,
      defaultOrg: orgName,
    },
  });
}

async function main() {
  const transport = argv.transport as string;
  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
