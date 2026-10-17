FROM node:24-bookworm-slim
WORKDIR /app/services/agenthub
COPY vendor/agent-network-protocol/ /app/vendor/agent-network-protocol/
COPY services/agenthub/package.json services/agenthub/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/agenthub/tsconfig.json ./
COPY services/agenthub/src ./src
RUN mkdir -p /var/lib/agenthub && chown node:node /var/lib/agenthub
ENV NODE_ENV=production PORT=8443
EXPOSE 8443
USER node
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
