FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/nexo
COPY services/agenthub/worker/package.json services/agenthub/worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/agenthub/worker/entry.mjs ./entry.mjs
RUN mkdir -p /workspace/work && chown -R node:node /workspace
ENV HOME=/workspace NODE_ENV=production
USER node
VOLUME /workspace
ENTRYPOINT ["node", "/opt/nexo/entry.mjs"]
