FROM node:22-bookworm-slim
# Install the compiler globally. A project-local `npm install` crashes npm
# 10.9.9 with `edgesOut` when this package has no lockfile and no runtime deps.
RUN npm install -g typescript@5.9.3 @types/node@24.13.3
WORKDIR /srv/conversation-sync
# package.json must be present before tsc. NodeNext reads `"type": "module"`
# from it; without that file the sources are compiled as CommonJS and
# `import.meta` fails.
COPY package.json tsconfig.docker.json ./
COPY src ./src
COPY scripts ./scripts
RUN tsc -p tsconfig.docker.json \
 && node scripts/copy-console.mjs \
 && node --check dist/main.js \
 && test -f dist/console/index.html \
 && test -f dist/console/app.js \
 && test -f dist/console/app.css
ENV SYNC_HOST=0.0.0.0
ENV SYNC_PORT=8788
ENV SYNC_DB=/data/conversation-sync.sqlite
EXPOSE 8788
VOLUME ["/data"]
CMD ["node", "dist/main.js"]
