#!/bin/sh
#
# 构建并推送业务应用镜像。
# 这个脚本运行在 CI 环境中，负责登录镜像仓库、按当前提交构建应用镜像，
# 并推送稳定 tag 与带短 SHA 的版本 tag，供后续 deploy 直接拉取。

set -eu

# 校验业务镜像构建所需的核心变量。
: "${APP_IMAGE_REPOSITORY:?APP_IMAGE_REPOSITORY is required}"
: "${IMAGE_TAG_STABLE:?IMAGE_TAG_STABLE is required}"
: "${IMAGE_TAG_VERSION:?IMAGE_TAG_VERSION is required}"
: "${PNPM_VERSION:?PNPM_VERSION is required}"

APP_IMAGE_REGISTRY="${APP_IMAGE_REPOSITORY%%/*}"
APP_IMAGE_REGISTRY_USERNAME="${APP_IMAGE_REGISTRY_USERNAME:-${BASE_IMAGE_REGISTRY_USERNAME:-}}"
APP_IMAGE_REGISTRY_PASSWORD="${APP_IMAGE_REGISTRY_PASSWORD:-${BASE_IMAGE_REGISTRY_PASSWORD:-}}"

: "${APP_IMAGE_REGISTRY_USERNAME:?APP_IMAGE_REGISTRY_USERNAME or BASE_IMAGE_REGISTRY_USERNAME is required}"
: "${APP_IMAGE_REGISTRY_PASSWORD:?APP_IMAGE_REGISTRY_PASSWORD or BASE_IMAGE_REGISTRY_PASSWORD is required}"

APP_IMAGE_STABLE="${APP_IMAGE_REPOSITORY}:${IMAGE_TAG_STABLE}"
APP_IMAGE_VERSION="${APP_IMAGE_REPOSITORY}:${IMAGE_TAG_VERSION}"
BASE_IMAGE=""

if [ -n "${BASE_IMAGE_REPOSITORY:-}" ] && [ -n "${BASE_IMAGE_TAG:-}" ]; then
  BASE_IMAGE="${BASE_IMAGE_REPOSITORY}:${BASE_IMAGE_TAG}"
fi

# 登录镜像仓库，优先尝试使用预构建基础镜像加速应用镜像构建。
printf '%s' "${APP_IMAGE_REGISTRY_PASSWORD}" | docker login "${APP_IMAGE_REGISTRY}" -u "${APP_IMAGE_REGISTRY_USERNAME}" --password-stdin

set -- \
  --file ./Dockerfile \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --tag "${APP_IMAGE_STABLE}" \
  --tag "${APP_IMAGE_VERSION}" \
  .

if [ -n "${BASE_IMAGE}" ] && docker pull "${BASE_IMAGE}" > /dev/null 2>&1; then
  set -- \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    "$@"
fi

docker build "$@"

docker push "${APP_IMAGE_STABLE}"
docker push "${APP_IMAGE_VERSION}"
