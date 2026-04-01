#!/bin/sh
#
# 手动回滚入口。
# 默认会自动解析目标环境上一次已部署的镜像 tag，然后复用 deploy.sh 的
# 远端部署逻辑；如果显式提供 ROLLBACK_IMAGE_TAG，则优先使用手工指定版本。

set -eu

: "${STACK_DIR:?STACK_DIR is required}"
: "${DEPLOY_TARGET:?DEPLOY_TARGET is required}"
: "${ENV_KEY:?ENV_KEY is required}"
: "${SERVER_USER:?SERVER_USER is required}"
: "${SERVER_HOST:?SERVER_HOST is required}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}"

if [ -z "${ROLLBACK_IMAGE_TAG:-}" ]; then
  ROLLBACK_IMAGE_TAG="$(
    ssh "${SERVER_USER}@${SERVER_HOST}" /bin/sh -s -- \
      "${STACK_DIR}" \
      "${ENV_KEY}" \
      "${DEPLOY_TARGET}" < ./.gitlab/cd/resolve-rollback-tag.sh
  )"
fi

case "${ROLLBACK_IMAGE_TAG}" in
  "${DEPLOY_TARGET}" | "${DEPLOY_TARGET}"-*)
    ;;
  *)
    echo "ROLLBACK_IMAGE_TAG must be '${DEPLOY_TARGET}' or start with '${DEPLOY_TARGET}-'" >&2
    exit 1
    ;;
esac

DEPLOY_IMAGE_TAG="${ROLLBACK_IMAGE_TAG}" sh ./.gitlab/cd/deploy.sh
