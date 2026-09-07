# ---- build ----------------------------------------------------------------
# Node 22.13+ is required: the SQLite driver uses the built-in node:sqlite
# module, which means the image needs no native build toolchain at all.
FROM node:22-alpine AS build
WORKDIR /app

# Only devDependencies exist (TypeScript and its node types); the runtime
# image below installs nothing at all.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CUMULO_DATABASE_FILE=/data/cumulo.db
WORKDIR /app

# Only the compiled output and the manifest; there are no runtime dependencies.
# The compiled tests come along too, so `docker run <image> npm test` style
# checks can be run against the very image that ships.
COPY --from=build /app/dist ./dist
COPY package.json ./

# The database lives on a volume so an installation survives a new image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/main.js"]
