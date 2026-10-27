FROM node:22-bookworm-slim
WORKDIR /srv/conversation-sync
COPY package.json tsconfig.json ./
COPY src ./src
ENV SYNC_HOST=0.0.0.0
ENV SYNC_PORT=8788
ENV SYNC_DB=/data/conversation-sync.sqlite
EXPOSE 8788
VOLUME ["/data"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
