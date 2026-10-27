FROM node:22-bookworm-slim
# Install the compiler globally. A project-local `npm install` crashes npm
# 10.9.9 with `edgesOut` when this package has no lockfile and no runtime deps.
RUN npm install -g typescript@5.9.3 @types/node@24.13.3
WORKDIR /srv/conversation-sync
COPY tsconfig.docker.json ./
COPY src ./src
RUN tsc -p tsconfig.docker.json && cp src/console.html dist/console.html
ENV SYNC_HOST=0.0.0.0
ENV SYNC_PORT=8788
ENV SYNC_DB=/data/conversation-sync.sqlite
EXPOSE 8788
VOLUME ["/data"]
CMD ["node", "dist/main.js"]
