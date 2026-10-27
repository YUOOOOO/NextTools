FROM node:22-bookworm-slim
WORKDIR /srv/conversation-sync
COPY package.json package-lock.json* tsconfig.docker.json ./
COPY src ./src
RUN npm install && npx tsc -p tsconfig.docker.json && cp src/console.html dist/console.html && npm prune --omit=dev
ENV SYNC_HOST=0.0.0.0
ENV SYNC_PORT=8788
ENV SYNC_DB=/data/conversation-sync.sqlite
EXPOSE 8788
VOLUME ["/data"]
CMD ["node", "dist/main.js"]
