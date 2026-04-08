#!/bin/sh
#
# 作为 CD 流程入口，整理部署参数并远程执行真正的部署脚本。
# 这个脚本运行在 GitLab Runner 上，负责校验变量、准备镜像仓库凭据和
# docker-compose 配置，然后通过 SSH 调用目标机器上的纯部署逻辑。
# 默认会部署当前提交对应的镜像；如果显式传入 DEPLOY_IMAGE_TAG，则改为部署指定版本。

set -eu

# 校验部署所需的核心 CI 变量。
: "${STACK_DIR:?STACK_DIR is required}"
: "${DEPLOY_TARGET:?DEPLOY_TARGET is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${ENV_KEY:?ENV_KEY is required}"
: "${APP_IMAGE_REPOSITORY:?APP_IMAGE_REPOSITORY is required}"
: "${SERVER_USER:?SERVER_USER is required}"
: "${SERVER_HOST:?SERVER_HOST is required}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}"

# 普通部署默认使用当前提交对应的镜像版本；回滚场景可通过 DEPLOY_IMAGE_TAG 覆盖。
if [ -n "${DEPLOY_IMAGE_TAG:-}" ]; then
  APP_IMAGE_TAG="${DEPLOY_IMAGE_TAG}"
else
  : "${CI_COMMIT_SHORT_SHA:?CI_COMMIT_SHORT_SHA is required when DEPLOY_IMAGE_TAG is not set}"
  APP_IMAGE_TAG="${DEPLOY_TARGET}-${CI_COMMIT_SHORT_SHA}"
fi

APP_IMAGE_REGISTRY="${APP_IMAGE_REPOSITORY%%/*}"
APP_IMAGE_REGISTRY_USERNAME="${APP_IMAGE_REGISTRY_USERNAME:-}"
APP_IMAGE_REGISTRY_PASSWORD_B64=""
DOCKER_COMPOSE_B64="$(base64 < ./docker-compose.yml | tr -d '\n')"

# 当应用镜像仓库凭据齐全时，传递给部署机用于拉取镜像。
if [ -n "${APP_IMAGE_REGISTRY_USERNAME:-}" ] && [ -n "${APP_IMAGE_REGISTRY_PASSWORD:-}" ]; then
  APP_IMAGE_REGISTRY_PASSWORD_B64="$(printf '%s' "${APP_IMAGE_REGISTRY_PASSWORD}" | base64 | tr -d '\n')"
fi

# 通过 SSH 把参数传给目标机器上的远端部署脚本。
ssh "${SERVER_USER}@${SERVER_HOST}" /bin/sh -s -- \
  "${STACK_DIR}" \
  "${CONTAINER_NAME}" \
  "${ENV_KEY}" \
  "${APP_IMAGE_REPOSITORY}" \
  "${APP_IMAGE_TAG}" \
  "${DOCKER_COMPOSE_B64}" \
  "${APP_IMAGE_REGISTRY}" \
  "${APP_IMAGE_REGISTRY_USERNAME}" \
  "${APP_IMAGE_REGISTRY_PASSWORD_B64}" < ./.gitlab/cd/deploy-remote.sh
