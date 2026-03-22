# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts avoids the preinstall registry override; we run build manually below
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Generate src/version.ts then compile TypeScript
RUN node -e " \
      const {version} = JSON.parse(require('fs').readFileSync('package.json', 'utf8')); \
      require('fs').writeFileSync('src/version.ts', 'export const packageVersion = ' + JSON.stringify(version) + ';\n'); \
    " \
 && npx tsc

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# ── Required for HTTP / Claude.ai mode ──────────────────────────────────────
# ADO organisation name
ENV ADO_ORG=""
# Public HTTPS URL of this server (used in OAuth redirect URIs)
ENV MCP_BASE_URL=""
# Azure AD app registration for the IBT tenant
ENV AZURE_TENANT_ID=""
ENV AZURE_CLIENT_ID=""
ENV AZURE_CLIENT_SECRET=""

# ── Optional tuning ─────────────────────────────────────────────────────────
ENV PORT=3000
ENV LOG_LEVEL=info
# Comma-separated allowed CORS origins, or * for any
ENV CORS_ORIGINS="*"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
# HTTP transport with OAuth; org and OAuth credentials come from env vars above
CMD ["--transport", "http"]
