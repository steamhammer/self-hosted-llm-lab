# syntax=docker/dockerfile:1
# Lab image: the official vLLM image plus this repository, Node.js and rclone. No secrets inside:
# keys arrive as environment variables when the pod is created.
#
#   docker buildx build --platform linux/amd64 -f infra/image/Dockerfile \
#     --build-arg LAB_GIT_SHA="$(git rev-parse HEAD)" -t ghcr.io/<owner>/llm-lab:<tag> .
#
# Built and pushed by .github/workflows/lab-image.yml. The final stage adds a torchcodec fix and
# COPY layers on top of vLLM, so a host that already caches vllm/vllm-openai pulls a few hundred MB.

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
# vllm-openai:v0.32.0-cu129 ships torchcodec 0.17.0, a CUDA 13 build that cannot load in this
# CUDA 12.9 image, and `vllm serve` dies on import even for text-only models
# (https://github.com/vllm-project/vllm/issues/63121). Install the matching cu129 build, the
# workaround confirmed there, and fail the image build if the import is still broken.
RUN PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --no-cache-dir --no-deps --force-reinstall \
      --index-url https://download.pytorch.org/whl/cu129 "torchcodec==0.16.0" \
 && python3 -c "import torchcodec.decoders; print('torchcodec', torchcodec.__version__, 'ok')"
# Experiment 2 quality runs (bench/eval, docs/adr/0007): lm-eval in its own venv, so its
# datasets/evaluate pins cannot touch vLLM's packages. The task datasets and IFEval's NLTK data
# are baked in, so a pod spends no paid minutes downloading them. Version as in bench/pyproject.toml.
ARG LM_EVAL_VERSION=0.4.13
ENV HF_DATASETS_CACHE=/opt/lab-eval/hf-datasets \
    NLTK_DATA=/opt/lab-eval/nltk_data
RUN python3 -m pip install --no-cache-dir uv \
 && uv venv /opt/lab-eval --python python3 \
 && uv pip install --no-cache --python /opt/lab-eval/bin/python "lm-eval[api,ifeval]==${LM_EVAL_VERSION}" \
 && /opt/lab-eval/bin/python -c "import nltk; nltk.download('punkt_tab', download_dir='/opt/lab-eval/nltk_data')" \
 && /opt/lab-eval/bin/python -c "from lm_eval.tasks import TaskManager, get_task_dict; \
get_task_dict(['gsm8k_cot_llama', 'mmlu_pro', 'ifeval'], TaskManager()); print('eval datasets cached')"
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
