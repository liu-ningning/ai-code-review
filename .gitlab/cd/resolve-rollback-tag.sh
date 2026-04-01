#!/bin/sh
#
# 在目标机器上解析某个环境的上一个已部署镜像 tag。
# 优先从部署历史中读取最后一个与当前 tag 不同的记录，用于自动回滚。

set -eu

STACK_DIR="$1"
ENV_KEY="$2"
DEPLOY_TARGET="$3"
DEPLOY_HISTORY_FILE="${STACK_DIR}/.deploy-history/${ENV_KEY}.log"
CURRENT_IMAGE_TAG=""
ROLLBACK_IMAGE_TAG=""

cd "${STACK_DIR}"

if [ -f .env ]; then
  CURRENT_IMAGE_TAG="$(awk -F= -v key="${ENV_KEY}" '$1 == key { value=$2 } END { print value }' .env)"
fi

if [ -f "${DEPLOY_HISTORY_FILE}" ]; then
  ROLLBACK_IMAGE_TAG="$(awk -v current="${CURRENT_IMAGE_TAG}" 'NF && $0 != current { last=$0 } END { print last }' "${DEPLOY_HISTORY_FILE}")"
fi

if [ -z "${ROLLBACK_IMAGE_TAG}" ]; then
  echo "No previous deployed image tag found for ${ENV_KEY}" >&2
  exit 1
fi

case "${ROLLBACK_IMAGE_TAG}" in
  "${DEPLOY_TARGET}" | "${DEPLOY_TARGET}"-*)
    printf '%s\n' "${ROLLBACK_IMAGE_TAG}"
    ;;
  *)
    echo "Resolved rollback image tag '${ROLLBACK_IMAGE_TAG}' does not belong to ${DEPLOY_TARGET}" >&2
    exit 1
    ;;
esac
