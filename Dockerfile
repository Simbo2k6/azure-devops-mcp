# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Generate version.ts and compile TypeScript
RUN node -p "'export const packageVersion = ' + JSON.stringify(require('./package.json').version) + ';\n'" > src/version.ts \
    && npx tsc

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Default environment variables (override at runtime)
ENV PORT=3000
ENV ADO_ORG=""
ENV ADO_MCP_AUTH_TOKEN=""
ENV LOG_LEVEL=info
ENV CORS_ORIGINS="*"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
# Default: HTTP transport; org from ADO_ORG env var; envvar auth from ADO_MCP_AUTH_TOKEN
CMD ["--transport", "http", "--authentication", "envvar"]
