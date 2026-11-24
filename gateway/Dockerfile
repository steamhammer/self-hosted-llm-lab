# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker buildx build --platform linux/amd64 -f gateway/Dockerfile -t llm-lab-gateway .
#
# The gateway is bundled into a single file (gateway/dist/gateway.mjs, no node_modules needed),
# so the same artifact can later be dropped into the vLLM-based lab image as a sidecar process.

FROM node:26-slim AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm version comes from "packageManager" in package.json
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
COPY gateway/package.json gateway/
COPY mock-upstream/package.json mock-upstream/
RUN pnpm install --frozen-lockfile
COPY gateway/ gateway/
RUN pnpm --filter gateway bundle

FROM node:26-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /repo/gateway/dist/gateway.mjs ./gateway.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "gateway.mjs"]
