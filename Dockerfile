# ---- build ----------------------------------------------------------------
# Node 22.13+ is required: the SQLite driver uses the built-in node:sqlite
# module, which means the image needs no native build toolchain at all.
#
# The build stage also bundles the Mantine client. React, Mantine and esbuild
# are devDependencies: they are compiled into dist/public here and never
# installed into the runtime image.
FROM node:22-alpine AS build
WORKDIR /app

# Everything here is a devDependency -- TypeScript, esbuild, React, Mantine --
# and all of it is compiled away. The runtime image installs nothing.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.client.json ./
COPY scripts ./scripts
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
# dist carries the server, the compiled tests and the client bundle under
# dist/public, so one COPY ships everything the container serves.
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
