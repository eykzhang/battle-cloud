# The battle-cloud API tier.
#
#   docker buildx build -f docker/api.Dockerfile -t battle-cloud-api:dev --load .
#
# No named build contexts: unlike the worker, this tier depends on nothing outside this
# repo.

FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY api/package.json api/package-lock.json ./
# `npm ci` rather than `npm install`: it installs exactly the lockfile and fails if the
# manifest and lockfile disagree, which is what a reproducible image needs.
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY api/package.json ./package.json
COPY api/src ./src

# Node 22 runs TypeScript by stripping types, so there is no build step and no dist/.
# The tradeoff is that strip-only mode rejects some syntax (constructor parameter
# properties, enums), which is why src/ avoids them.
RUN node --experimental-strip-types -e "import('./src/config.ts')" \
 && echo "api sources load under type stripping"

EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/server.ts"]
