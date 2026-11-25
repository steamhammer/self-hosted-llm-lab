# syntax=docker/dockerfile:1
# Lab image: the official vLLM image plus this repository, Node.js and rclone. No secrets inside:
# keys arrive as environment variables when the pod is created.
#
#   docker buildx build --platform linux/amd64 -f infra/image/Dockerfile \
#     --build-arg LAB_GIT_SHA="$(git rev-parse HEAD)" -t ghcr.io/<owner>/llm-lab:<tag> .
#
# Built and pushed by .github/workflows/lab-image.yml. The final stage only adds COPY layers
# on top of vLLM, so a provider that already caches vllm/vllm-openai pulls just a few hundred MB.

# CUDA 12.9 build: more rental hosts have a driver for 12.9 than for 13.0 (the default tag).
# Images: https://hub.docker.com/r/vllm/vllm-openai/tags
ARG VLLM_IMAGE=vllm/vllm-openai:v0.32.0-cu129
ARG NODE_IMAGE=node:26-slim
ARG RCLONE_IMAGE=rclone/rclone:1.75.2

FROM ${NODE_IMAGE} AS node

# Workspace dependencies and the single-file gateway bundle.
FROM node AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
COPY gateway/package.json gateway/
COPY loadgen/package.json loadgen/
COPY mock-upstream/package.json mock-upstream/
RUN pnpm install --frozen-lockfile
COPY gateway/ gateway/
RUN pnpm --filter gateway bundle

# Runtime dependencies only (loadgen and the mock upstream run as TypeScript via type stripping).
FROM node AS prod
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
COPY gateway/package.json gateway/
COPY loadgen/package.json loadgen/
COPY mock-upstream/package.json mock-upstream/
RUN pnpm install --frozen-lockfile --prod
COPY loadgen/ loadgen/
COPY mock-upstream/ mock-upstream/
COPY bench/ bench/
COPY serving/ serving/
COPY infra/ infra/
COPY docs/methodology.md docs/
COPY --from=build /repo/gateway/dist/gateway.mjs gateway/dist/gateway.mjs
RUN chmod +x infra/*.sh infra/jobs/*.sh bench/*.sh

FROM ${RCLONE_IMAGE} AS rclone

FROM ${VLLM_IMAGE}
ARG VLLM_IMAGE
ARG LAB_GIT_SHA=unknown
# Official Node.js binaries need only glibc >= 2.28, which the vLLM (Ubuntu) base has.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=prod /repo /lab
ENV VLLM_IMAGE=${VLLM_IMAGE} \
    LAB_GIT_SHA=${LAB_GIT_SHA} \
    NODE_ENV=production
WORKDIR /lab
EXPOSE 8000 8080
ENTRYPOINT ["/lab/infra/bootstrap.sh"]
