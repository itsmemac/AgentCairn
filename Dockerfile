# Agent Cairn server (MCP over HTTP + dashboard). Build: docker build -t cairn .
# The build stage always runs on the build machine's own architecture: everything we ship is
# plain JavaScript, so there is nothing to compile per platform. (Running npm under QEMU
# emulation for arm64 crashes Node with "Illegal instruction".) The final stage only copies files.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
RUN npm ci
COPY packages/core packages/core
COPY packages/mcp-server packages/mcp-server
RUN npm run build -w @agentcairn/core -w @agentcairn/mcp-server \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    CAIRN_HOST=0.0.0.0 \
    CAIRN_PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build --chown=node:node /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build --chown=node:node /app/packages/mcp-server/ui ./packages/mcp-server/ui
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "packages/mcp-server/dist/serve.js"]
