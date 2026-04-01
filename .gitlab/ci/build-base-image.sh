#!/bin/sh
#
# 构建并推送 review 服务使用的基础镜像。
# 这个脚本运行在 CI 环境中，负责登录镜像仓库、按固定 Dockerfile
# 生成带 git 和 pnpm 的基础镜像，并将其推送到远端仓库。

set -eu

# 校验基础镜像构建所需的关键 CI 变量。
: "${BASE_IMAGE_REPOSITORY:?BASE_IMAGE_REPOSITORY is required}"
: "${BASE_IMAGE_TAG:?BASE_IMAGE_TAG is required}"
: "${BASE_IMAGE_REGISTRY_USERNAME:?BASE_IMAGE_REGISTRY_USERNAME is required}"
: "${BASE_IMAGE_REGISTRY_PASSWORD:?BASE_IMAGE_REGISTRY_PASSWORD is required}"
: "${PNPM_VERSION:?PNPM_VERSION is required}"
: "${NODE_BASE_IMAGE:?NODE_BASE_IMAGE is required}"
: "${DEBIAN_MIRROR_HOST:?DEBIAN_MIRROR_HOST is required}"
: "${NPM_REGISTRY:?NPM_REGISTRY is required}"

BASE_IMAGE="${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG}"
BASE_IMAGE_REGISTRY="${BASE_IMAGE_REPOSITORY%%/*}"

# 登录镜像仓库并构建、推送基础镜像。
printf '%s' "${BASE_IMAGE_REGISTRY_PASSWORD}" | docker login "${BASE_IMAGE_REGISTRY}" -u "${BASE_IMAGE_REGISTRY_USERNAME}" --password-stdin

if docker pull "${BASE_IMAGE}" > /dev/null 2>&1; then
  docker build \
    --file ./Dockerfile.base \
    --cache-from "${BASE_IMAGE}" \
    --build-arg "BUILDKIT_INLINE_CACHE=1" \
    --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "DEBIAN_MIRROR_HOST=${DEBIAN_MIRROR_HOST}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --tag "${BASE_IMAGE}" \
    .
else
  docker build \
    --file ./Dockerfile.base \
    --build-arg "BUILDKIT_INLINE_CACHE=1" \
    --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "DEBIAN_MIRROR_HOST=${DEBIAN_MIRROR_HOST}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --tag "${BASE_IMAGE}" \
    .
fi

docker push "${BASE_IMAGE}"
