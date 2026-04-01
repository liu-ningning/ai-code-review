#!/bin/sh
#
# 在目标机器上执行实际部署。
# 这个脚本负责拉取 CI 已经构建好的应用镜像、同步 docker-compose，
# 更新 stack 环境变量并启动指定容器。
# 同时会把本次切换前的镜像 tag 记录到部署历史中，供后续自动回滚使用。

set -eu

STACK_DIR="$1"
CONTAINER_NAME="$2"
ENV_KEY="$3"
APP_IMAGE_REPOSITORY="$4"
APP_IMAGE_TAG="$5"
DOCKER_COMPOSE_B64="$6"
APP_IMAGE_REGISTRY="$7"
APP_IMAGE_REGISTRY_USERNAME="$8"
APP_IMAGE_REGISTRY_PASSWORD_B64="$9"
DEPLOY_HISTORY_DIR="${STACK_DIR}/.deploy-history"
DEPLOY_HISTORY_FILE="${DEPLOY_HISTORY_DIR}/${ENV_KEY}.log"
CURRENT_IMAGE_TAG=""

# 同步 docker-compose 文件并更新 stack 环境变量。
mkdir -p "${STACK_DIR}"
printf '%s' "${DOCKER_COMPOSE_B64}" | base64 -d > "${STACK_DIR}/docker-compose.yml"
cd "${STACK_DIR}"

if [ -f .env ]; then
  CURRENT_IMAGE_TAG="$(awk -F= -v key="${ENV_KEY}" '$1 == key { value=$2 } END { print value }' .env)"
fi

# 登录镜像仓库并拉取当前提交对应的镜像版本。
if [ -n "${APP_IMAGE_REGISTRY}" ] && [ -n "${APP_IMAGE_REGISTRY_USERNAME}" ] && [ -n "${APP_IMAGE_REGISTRY_PASSWORD_B64}" ]; then
  printf '%s' "${APP_IMAGE_REGISTRY_PASSWORD_B64}" | base64 -d | docker login "${APP_IMAGE_REGISTRY}" -u "${APP_IMAGE_REGISTRY_USERNAME}" --password-stdin
fi

docker pull "${APP_IMAGE_REPOSITORY}:${APP_IMAGE_TAG}"

if [ -f .env ]; then
  if grep -q "^AI_REVIEW_IMAGE_REPOSITORY=" .env; then
    sed -i "s#^AI_REVIEW_IMAGE_REPOSITORY=.*#AI_REVIEW_IMAGE_REPOSITORY=${APP_IMAGE_REPOSITORY}#g" .env
  else
    echo "AI_REVIEW_IMAGE_REPOSITORY=${APP_IMAGE_REPOSITORY}" >> .env
  fi
else
  echo "AI_REVIEW_IMAGE_REPOSITORY=${APP_IMAGE_REPOSITORY}" >> .env
fi

if [ -f .env ]; then
  if grep -q "^${ENV_KEY}=" .env; then
    sed -i "s#^${ENV_KEY}=.*#${ENV_KEY}=${APP_IMAGE_TAG}#g" .env
  else
    echo "${ENV_KEY}=${APP_IMAGE_TAG}" >> .env
  fi
else
  echo "${ENV_KEY}=${APP_IMAGE_TAG}" >> .env
fi

# 启动目标容器并清理旧镜像。
docker compose up -d --no-deps "${CONTAINER_NAME}"

if [ -n "${CURRENT_IMAGE_TAG}" ] && [ "${CURRENT_IMAGE_TAG}" != "${APP_IMAGE_TAG}" ]; then
  mkdir -p "${DEPLOY_HISTORY_DIR}"
  printf '%s\n' "${CURRENT_IMAGE_TAG}" >> "${DEPLOY_HISTORY_FILE}"
fi

docker image prune -f --filter "until=72h"
